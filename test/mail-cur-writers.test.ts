/**
 * For CLI signed-inbox delivery, promote() is the only first-delivery writer of cur/.
 * Updates to existing records are enumerated below; presentation is separately gated.
 * MailClient applies the same policy; outbox and internal mail are separate stores.
 * Scans scripts/, package src/ and scripts/, and plugin src/ with text patterns.
 * mail.ts's writeMessageFile calls are always cur candidates; other destinations
 * use cur literals and names. Unrecognized destinations may be missed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Which argument is the DESTINATION: "first" or a 0-based index. */
type Dest = "first" | number;

/** Write calls and which argument is the DESTINATION. */
const WRITE_CALLS: Record<string, Dest> = {
  appendFile: "first",
  appendFileSync: "first",
  "Bun.write": "first",
  copyFile: 1,
  copyFileSync: 1,
  cpSync: 1,
  createWriteStream: "first",
  link: 1,
  linkSync: 1,
  rename: 1,
  renameSync: 1,
  writeFile: "first",
  writeFileSync: "first",
};

/**
 * Each entry must match exactly one call: a stale entry, or a
 * second call matching an entry, fails the test.
 */
const ALLOWED: Array<{ file: string; contains: string; followedBy?: string; why: string }> = [
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: 'writeFileSync(path, JSON.stringify(msg, null, 2), "utf-8")',
    why: "writeMessageFile primitive — its call sites are enumerated below",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "renameSync(scratchPath, curPath)",
    why: "promote() — first delivery into a mailbox's cur/",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(full, present)",
    why: "checkMessages' lease sweep — re-stamps a record already in cur/ after recoverPromoted re-verified it",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(scratchPath, promoted)",
    why: "promote() — writes tmp/ staging before the checked atomic cur/ commit",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "ackMessageAtPath(path)",
    why: "ackMessage — delegates the record found by id to the existing-only path acknowledgement",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(path, msg, true)",
    followedBy: "; }",
    why: "setBridgeSentAtPath — updates only an existing record",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(path, msg, true)",
    followedBy: "; try { unlinkSync(path)",
    why: "ackMessageAtPath — updates only the existing record at that path, then unlinks it",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(path, msg)",
    followedBy: "; renameSync(path, target)",
    why: "nackMessage permanent — updates an existing record found by id, then moves it to dlq/; presentation is separately gated",
  },
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "writeMessageFile(path, msg)",
    followedBy: "; return msg",
    why: "nackMessage transient/agent — updates an existing record found by id; presentation is separately gated",
  },
  {
    file: "plugins/openclaw-tps-mail/src/index.ts",
    contains: "patchMailFile(ctx.curPath, { ackedAt:",
    why: "ack enrichment only — patchMailFile returns unless an existing record parses; it never creates a record",
  },
  {
    file: "plugins/openclaw-tps-mail/src/index.ts",
    contains: "patchMailFile(ctx.curPath, { nackedAt:",
    why: "nack enrichment only — patchMailFile returns unless an existing record parses; it never creates a record",
  },
  {
    file: "packages/agent/src/io/mail.ts",
    contains: "renameSync(srcPath, dstPath)",
    why: "MailClient — shared mailbox policy and replay store",
  },
  {
    file: "packages/cli/src/utils/relay.ts",
    contains: "renameSync(src, join(outCur, f))",
    why: "the container outbox/cur ARCHIVE — a sent-mail store, not an inbox; no promotion step exists there",
  },
  {
    file: "packages/cli/src/utils/internal-mail.ts",
    contains: "renameSync(fromPath, toPath)",
    why: "the office internal-mail store — a separate inbox outside the signed-envelope promotion path",
  },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures", "test-reports"]);

/** Every `.ts`/`.js` source file the scan covers. */
function sourceFiles(): string[] {
  const roots = ["scripts"];
  for (const pkg of readdirSync("packages")) {
    for (const sub of ["src", "scripts"]) {
      const dir = join("packages", pkg, sub);
      try {
        if (statSync(dir).isDirectory()) roots.push(dir);
      } catch {
        /* package has no such dir */
      }
    }
  }
  for (const plugin of readdirSync("plugins")) {
    const dir = join("plugins", plugin, "src");
    try {
      if (statSync(dir).isDirectory()) roots.push(dir);
    } catch {
      /* plugin has no src dir */
    }
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(p);
        continue;
      }
      if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

const CUR_LITERAL = /["'`]cur["'`]|\.cur\b/;

/** Drop string/template bodies and comments so identifiers can be read from code. */
function codeOnly(text: string): string {
  return text
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "S")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "S")
    .replace(/`(?:[^`\\]|\\.)*`/g, "S")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

const IDENT = /[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/g;

function identifiers(expr: string): string[] {
  return [...codeOnly(expr).matchAll(IDENT)].map((m) => m[0]!.split(".").pop()!);
}

function hasCurWord(name: string): boolean {
  return name.split(/[^A-Za-z0-9]+|(?=[A-Z])/).some((w) => w.toLowerCase() === "cur");
}

function curNames(text: string): Set<string> {
  const names = new Set<string>();
  const add = (name: string, rhs: string) => {
    if (names.has(name)) return;
    if (CUR_LITERAL.test(rhs)) names.add(name);
    else if (identifiers(rhs).some((n) => hasCurWord(n) || names.has(n))) names.add(name);
  };
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) add(m[1]!, m[2]!);
  for (const m of text.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) add(m[1]!, m[2]!);
  return names;
}

function isCurDestination(dest: string, names: Set<string>): boolean {
  if (CUR_LITERAL.test(dest)) return true;
  return identifiers(dest).some((n) => hasCurWord(n) || names.has(n));
}

function callArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(current);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(current);
      current = "";
      continue;
    }
    if (depth >= 1 && !(depth === 1 && ch === "(")) current += ch;
  }
  return args;
}

function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && --depth === 0) return i + 1;
  }
  return text.length;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function callsOf(text: string, fn: string): Array<{ at: number; args: string[] }> {
  const out: Array<{ at: number; args: string[] }> = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$])${escape(fn)}\\s*\\(`, "g"))) {
    if (/\bfunction\s+$/.test(text.slice(0, m.index))) continue;
    out.push({ at: m.index!, args: callArgs(text, m.index! + m[0].length - 1) });
  }
  return out;
}

function destOf(args: string[], spec: Dest): string | undefined {
  if (spec === "first") return args[0];
  return args[spec];
}

function writeCallsFor(text: string): Record<string, Dest> {
  const calls: Record<string, Dest> = { ...WRITE_CALLS };
  const decls: Array<{ name: string; params: string[]; body: string }> = [];
  const heads = [
    ...text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ...text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g),
  ];
  for (const d of heads) {
    const open = d.index! + d[0].length - 1;
    const close = groupEnd(text, open);
    const arrow = d[0].startsWith("function") ? /^\s*(?::[^{=;]+)?\{/ : /^\s*(?::[^{=;]+)?=>\s*\{/;
    const head = arrow.exec(text.slice(close));
    if (!head) continue;
    const bodyStart = close + head[0].length - 1;
    decls.push({
      name: d[1]!,
      params: callArgs(text, open).map((p) => p.trim().split(/[\s:=?]/)[0]!),
      body: text.slice(bodyStart, groupEnd(text, bodyStart)),
    });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, params, body } of decls) {
      if (name in calls) continue;
      const fdPaths = new Map<string, string>();
      for (const c of callsOf(body, "openSync")) {
        const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(body.slice(0, c.at));
        if (binding && c.args[0] !== undefined) fdPaths.set(binding[1]!, c.args[0]);
      }
      for (const [fn, spec] of Object.entries(calls)) {
        if (fn === name) continue;
        for (const c of callsOf(body, fn)) {
          const dest = destOf(c.args, spec);
          if (dest === undefined) continue;
          const ids = identifiers(dest);
          for (const id of [...ids]) {
            const path = fdPaths.get(id);
            if (path !== undefined) ids.push(...identifiers(path));
          }
          const idx = params.findIndex((p) => p !== "" && ids.includes(p));
          if (idx !== -1) {
            calls[name] = idx;
            changed = true;
            break;
          }
        }
        if (name in calls) break;
      }
    }
  }
  return calls;
}

function curWriterCalls(text: string, file?: string): Array<{ call: string; following: string }> {
  const names = curNames(text);
  const found: Array<{ call: string; following: string }> = [];
  for (const [fn, spec] of Object.entries(writeCallsFor(text))) {
    for (const c of callsOf(text, fn)) {
      if (c.args.length === 0) continue;
      const dest = destOf(c.args, spec);
      const recordPrimitive = file === "packages/cli/src/utils/mail.ts" && fn === "writeMessageFile";
      if (dest === undefined || (!recordPrimitive && !isCurDestination(dest, names))) continue;
      found.push({
        call: `${fn}(${c.args.map((a) => a.replace(/\s+/g, " ").trim()).join(", ")})`,
        following: codeOnly(text.slice(groupEnd(text, text.indexOf("(", c.at)))).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return found;
}

function curWritersInText(text: string): string[] {
  return curWriterCalls(text).map(({ call }) => call);
}

/** Match found calls against ALLOWED: each entry admits exactly one call. */
function classify(found: Array<{ file: string; call: string; following: string }>): { offenders: string[]; stale: string[] } {
  const offenders: string[] = [];
  const used = new Set<number>();
  for (const { file, call, following } of found) {
    const idx = ALLOWED.findIndex((entry, i) =>
      !used.has(i) && entry.file === file && call.includes(entry.contains) &&
      (!entry.followedBy || following.startsWith(entry.followedBy)),
    );
    if (idx === -1) offenders.push(`${file}: ${call}`);
    else used.add(idx);
  }
  const stale = ALLOWED.filter((_, i) => !used.has(i)).map((e) => `${e.file}: ${e.contains}`);
  return { offenders, stale };
}

function scanTree(override?: { file: string; text: string }): Array<{ file: string; call: string; following: string }> {
  const found: Array<{ file: string; call: string; following: string }> = [];
  for (const path of sourceFiles()) {
    const file = relative(process.cwd(), path);
    const text = override && override.file === file ? override.text : readFileSync(path, "utf-8");
    for (const site of curWriterCalls(text, file)) found.push({ file, ...site });
  }
  return found;
}

describe("cli#380: no unlisted detected writer of a cur/ directory", () => {
  test("every write into a cur/ directory the scan finds is a listed site", () => {
    const files = sourceFiles();
    // A scan that saw nothing is a probe smell, not a pass.
    expect(files.length).toBeGreaterThan(100);

    const { offenders, stale } = classify(scanTree());
    expect(offenders).toEqual([]);
    expect(stale).toEqual([]);
  });

  test("a second copy of an allowed call is reported", () => {
    const file = "packages/agent/src/io/mail.ts";
    const text = readFileSync(file, "utf-8");
    const dup = text.replace(
      "renameSync(srcPath, dstPath);",
      "renameSync(srcPath, dstPath);\n      renameSync(srcPath, dstPath);",
    );
    expect(dup).not.toBe(text);
    expect(classify(scanTree({ file, text: dup })).offenders).toEqual([
      `${file}: renameSync(srcPath, dstPath)`,
    ]);
  });

  test("plugin source writers are reported", () => {
    const file = "plugins/openclaw-tps-mail/src/index.ts";
    const text = readFileSync(file, "utf-8") + '\nwriteFileSync(join(root, "cur", "probe.json"), body);';
    expect(sourceFiles()).toContain(file);
    expect(classify(scanTree({ file, text })).offenders).toEqual([
      `${file}: writeFileSync(join(root, "cur", "probe.json"), body)`,
    ]);
  });

  test("a new resolve-by-id record writer is reported", () => {
    const file = "packages/cli/src/utils/mail.ts";
    const text = readFileSync(file, "utf-8") + `
function probe(agent: string, id: string) {
  const destination = messagePathById(agent, id);
  if (destination) writeMessageFile(destination, readMessageFile(destination));
}`;
    expect(classify(scanTree({ file, text })).offenders).toEqual([
      `${file}: writeMessageFile(destination, readMessageFile(destination))`,
    ]);
  });

  test("a write through a local wrapper, and Bun.write, are reported", () => {
    const text = [
      "function put(target: string, data: string) { writeFileSync(target, data); }",
      "function patch(target: string, data: string) { const fd = openSync(target, constants.O_WRONLY); writeFileSync(fd, data); }",
      "const move = (from: string, to: string) => { renameSync(from, to); };",
      "const inboxCur = join(root, \"cur\");",
      "put(join(inboxCur, f), body);",
      "patch(join(inboxCur, f), body);",
      "move(src, join(root, \"cur\", f));",
      "Bun.write(join(root, \"cur\", f), body);",
    ].join("\n");
    expect(curWritersInText(text).sort()).toEqual([
      "Bun.write(join(root, \"cur\", f), body)",
      "move(src, join(root, \"cur\", f))",
      "patch(join(inboxCur, f), body)",
      "put(join(inboxCur, f), body)",
    ]);
  });
});

for (const [fn, tail] of [["copyFile", ", 0, done"], ["copyFileSync", ", 0"], ["cpSync", ", { recursive: true }"], ["link", ", done"], ["rename", ", done"]]) {
  test(`${fn} sees the destination before options or callbacks, including local wrappers`, () => {
    const text = `function put(src, dest) { ${fn}(src, dest${tail}); }\n${fn}(src, join(root, "cur", f)${tail});\nput(src, join(root, "cur", f));`;
    expect(curWritersInText(text).sort()).toEqual([
      `${fn}(src, join(root, "cur", f)${tail})`,
      'put(src, join(root, "cur", f))',
    ].sort());
  });
}
