/**
 * mail-cur-writers.test.ts — cli#380: a source scan for writes into a `cur`
 * directory that are not on the list below.
 *
 * SCOPE, STATED. It reads scripts/ and every package's src/ and scripts/. It
 * reports a call to one of WRITE_CALLS, or to a function declared in the same
 * file that passes one of its parameters to a write call as the destination,
 * when the destination argument holds a `cur` string literal, a name with the
 * word "cur", or a name assigned from either. A destination reached any other
 * way (a path returned by a helper, a name from another file) is not seen. Each
 * listed site must match exactly one call.
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
 * Every write into a `cur` directory the scan may find. Each entry names the
 * file and the call, and must match exactly one call: a stale entry, or a
 * second call matching an entry, fails the test.
 */
const ALLOWED: Array<{ file: string; contains: string; why: string }> = [
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
    file: "packages/agent/src/io/mail.ts",
    contains: "renameSync(srcPath, dstPath)",
    why: "MailClient.commitToCur — runs the shared mailbox policy and replay store (@tpsdev-ai/agent mailbox-policy.ts) that promote() runs; @tpsdev-ai/agent cannot import packages/cli, so it cannot call promote()",
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

/** A name holds a `cur` path when one of its camelCase/snake_case words is "cur". */
function hasCurWord(name: string): boolean {
  return name.split(/[^A-Za-z0-9]+|(?=[A-Z])/).some((w) => w.toLowerCase() === "cur");
}

/** Locals and `this.X` fields bound to a cur path. */
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

/** The text from the bracket at `open` to its match, split at depth-1 commas. */
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

/** The index just past the bracket group that opens at `open`. */
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

/** Each call to `fn` in `text`: its offset and its argument texts. */
function callsOf(text: string, fn: string): Array<{ at: number; args: string[] }> {
  const out: Array<{ at: number; args: string[] }> = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$])${escape(fn)}\\s*\\(`, "g"))) {
    out.push({ at: m.index!, args: callArgs(text, m.index! + m[0].length - 1) });
  }
  return out;
}

function destOf(args: string[], spec: Dest): string | undefined {
  if (spec === "first") return args[0];
  return args[spec];
}

/**
 * The write calls of WRITE_CALLS plus every function declared in `text`
 * (`function f(...) {` or `const f = (...) => {`) that passes one of its own
 * parameters into the destination of a known write call.
 */
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
      for (const [fn, spec] of Object.entries(calls)) {
        if (fn === name) continue;
        for (const c of callsOf(body, fn)) {
          const dest = destOf(c.args, spec);
          if (dest === undefined) continue;
          const ids = identifiers(dest);
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

/** Every write call in `text` whose destination is a cur directory. */
function curWritersInText(text: string): string[] {
  const names = curNames(text);
  const found: string[] = [];
  for (const [fn, spec] of Object.entries(writeCallsFor(text))) {
    for (const c of callsOf(text, fn)) {
      if (c.args.length === 0) continue;
      const dest = destOf(c.args, spec);
      if (dest === undefined || !isCurDestination(dest, names)) continue;
      found.push(`${fn}(${c.args.map((a) => a.replace(/\s+/g, " ").trim()).join(", ")})`);
    }
  }
  return found;
}

/** Match found calls against ALLOWED: each entry admits exactly one call. */
function classify(found: Array<{ file: string; call: string }>): { offenders: string[]; stale: string[] } {
  const offenders: string[] = [];
  const used = new Set<number>();
  for (const { file, call } of found) {
    const idx = ALLOWED.findIndex((entry, i) => !used.has(i) && entry.file === file && call.includes(entry.contains));
    if (idx === -1) offenders.push(`${file}: ${call}`);
    else used.add(idx);
  }
  const stale = ALLOWED.filter((_, i) => !used.has(i)).map((e) => `${e.file}: ${e.contains}`);
  return { offenders, stale };
}

function scanTree(override?: { file: string; text: string }): Array<{ file: string; call: string }> {
  const found: Array<{ file: string; call: string }> = [];
  for (const path of sourceFiles()) {
    const file = relative(process.cwd(), path);
    const text = override && override.file === file ? override.text : readFileSync(path, "utf-8");
    for (const call of curWritersInText(text)) found.push({ file, call });
  }
  return found;
}

describe("cli#380: no unlisted writer of a cur/ directory", () => {
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

  test("a write through a local wrapper, and Bun.write, are reported", () => {
    const text = [
      "function put(target: string, data: string) { writeFileSync(target, data); }",
      "const move = (from: string, to: string) => { renameSync(from, to); };",
      "const inboxCur = join(root, \"cur\");",
      "put(join(inboxCur, f), body);",
      "move(src, join(root, \"cur\", f));",
      "Bun.write(join(root, \"cur\", f), body);",
    ].join("\n");
    expect(curWritersInText(text).sort()).toEqual([
      "Bun.write(join(root, \"cur\", f), body)",
      "move(src, join(root, \"cur\", f))",
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
