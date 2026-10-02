/**
 * mail-cur-writers.test.ts — cli#380: the enforceable half of the invariant
 * "only promote() writes a mailbox's cur/" — every write into a `cur` directory
 * is an allowed, listed site.
 *
 * `cur/` is a LIVE DELIVERY SOURCE (cli#377): a record that lands there is
 * re-verified and re-presented to a tool-holding model. Verification therefore
 * runs on the `new/` → `cur/` transition, and that transition has exactly one
 * implementation: `promote()` in `packages/cli/src/utils/mail.ts`. A second
 * writer is a second verification boundary — which is how the shipped verifier
 * stayed dead for weeks (cli#380).
 *
 * A convention nobody checks is how that happened, so this test READS THE
 * SOURCE TREE (scripts/ and every package's src/ and scripts/) and fails on any
 * write whose DESTINATION is a `cur` directory that is not one of the sites
 * below. Re-add a bypass and it goes red.
 *
 * SCOPE, STATED. The invariant is about a MAILBOX's `cur/` — the inbox store
 * `promote()` governs. Two other stores write a directory named `cur`, and
 * neither is an inbox with a promotion step: the container `outbox/cur` archive
 * (relay.ts) and the office internal-mail store (internal-mail.ts). They are
 * listed below, each with its reason, so they are visible decisions rather than
 * silent holes. The agent MailClient is listed for the same reason: it is a
 * live consumer in another package and cannot call `promote()` (the dependency
 * runs cli → agent), and its verification is mandatory — its verifier is a
 * required constructor argument, not an optional one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Write calls and which argument is the DESTINATION ("last" when trailing). */
const WRITE_CALLS: Record<string, "first" | "last"> = {
  appendFile: "first",
  appendFileSync: "first",
  copyFile: "last",
  copyFileSync: "last",
  cpSync: "last",
  createWriteStream: "first",
  link: "last",
  linkSync: "last",
  rename: "last",
  renameSync: "last",
  writeFile: "first",
  writeFileSync: "first",
};

/**
 * Every write into a `cur` directory the scan may find. Each entry names the
 * file and the call, so a stale entry (a site that moved or vanished) fails the
 * test too.
 */
const ALLOWED: Array<{ file: string; contains: string; why: string }> = [
  {
    file: "packages/cli/src/utils/mail.ts",
    contains: "renameSync(scratchPath, curPath)",
    why: "promote() — the ONE transition into a mailbox's cur/, the verification boundary itself",
  },
  {
    file: "packages/agent/src/io/mail.ts",
    contains: "renameSync(srcPath, dstPath)",
    why: "MailClient — verified promotion; @tpsdev-ai/agent cannot import packages/cli (cli → agent), so it cannot call promote(); its verifier is a required constructor argument",
  },
  {
    file: "packages/cli/src/utils/relay.ts",
    contains: "renameSync(src, join(outCur, f))",
    why: "the container outbox/cur ARCHIVE — a sent-mail store, not an inbox; no promotion step exists there",
  },
  {
    file: "packages/cli/src/utils/internal-mail.ts",
    contains: "renameSync(fromPath, toPath)",
    why: "the office internal-mail store — a separate mailroom with no envelope promotion",
  },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures", "test-reports"]);

/** Every `.ts`/`.js` source file the invariant covers. */
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

/** Locals and `this.X` fields bound to a cur path (one level of propagation). */
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

/** The call's arguments, from the `(` at `open` to its matching `)`. */
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

/** Every write call in the file whose destination is a cur directory. */
function curWriters(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const names = curNames(text);
  const found: string[] = [];
  for (const fn of Object.keys(WRITE_CALLS)) {
    for (const m of text.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))) {
      const args = callArgs(text, m.index! + m[0].length - 1);
      if (args.length === 0) continue;
      const dest = WRITE_CALLS[fn] === "last" ? args[args.length - 1]! : args[0]!;
      if (!isCurDestination(dest, names)) continue;
      found.push(`${fn}(${args.map((a) => a.replace(/\s+/g, " ").trim()).join(", ")})`);
    }
  }
  return found;
}

describe("cli#380: no unlisted writer of a cur/ directory", () => {
  test("every write into a cur/ directory in the source tree is an allowed, listed site", () => {
    const files = sourceFiles();
    // A scan that saw nothing is a probe smell, not a pass: the tree has the
    // promote() write, so the list below is never empty.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    const used = new Set<number>();
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      for (const call of curWriters(file)) {
        const idx = ALLOWED.findIndex((entry) => entry.file === rel && call.includes(entry.contains));
        if (idx === -1) offenders.push(`${rel}: ${call}`);
        else used.add(idx);
      }
    }

    expect(offenders).toEqual([]);
    // No stale entries: an allowlisted site that no longer exists must fail too,
    // or the list silently widens with rot.
    const stale = ALLOWED.filter((_, i) => !used.has(i)).map((e) => `${e.file}: ${e.contains}`);
    expect(stale).toEqual([]);
  });
});
