#!/usr/bin/env node
/**
 * check-test-coverage.mjs — cli#411: every test file must be run by a suite CI
 * runs, and the guard that says so must not be disarmable by the wiring it
 * polices.
 *
 * ROUND 1 put this check inside `packages/cli/test/test-coverage.test.ts`. It
 * ran only because the CLI suite ran, so dropping `cd ../cli && bun test` from
 * the root `test` script took the guard down together with the wiring it was
 * there to catch. It also searched the whole of `package.json` for the
 * substring "bun test ./test" and counted wiring text inside a workflow
 * comment, so a clause moved into an unused script — or commented out — still
 * read as wired.
 *
 * ROUND 2 — THE SHAPE:
 *
 *  1. This file is a STANDALONE SCRIPT, run as its own step in the Unit &
 *     Integration Tests job (`.github/workflows/test.yml`). Removing any suite
 *     clause leaves it running, and failing.
 *  2. It reads CONFIGURATION, not text. The covered roots come from the root
 *     `package.json`'s `scripts.test` — and from every script that calls, each
 *     followed through `cd` and `bun run <name>` — and from the workflow's own
 *     steps, parsed as YAML, whose `run:` values are shell programs (a comment
 *     in one is not a command).
 *  3. A step or script that NAMES a test run must yield the roots it covers. If
 *     the guard cannot derive them — a launcher it cannot read, a wrapper it
 *     cannot follow — it FAILS and says so. Guessing would either widen the
 *     covered set or hide the orphan this exists to find.
 *  4. The plugin's launcher (`plugins/openclaw-tps-mail/scripts/run-tests.mjs`,
 *     which the plugin's `test` script runs) is read for the root IT runs —
 *     `bun test test/` inside the plugin — so the covered root there is
 *     `plugins/openclaw-tps-mail/test`, not the whole plugin directory. A test
 *     file elsewhere in the plugin is an orphan, and is reported as one.
 *
 * A detective, not a boundary: a pull request can edit the wiring and this
 * script together, and the boundary is review of the diff. What it holds is
 * that the wiring cannot go quiet — a suite dropped from the root `test`
 * script, a workflow step deleted, a clause moved into an unused script or
 * commented out, a guard disarmed by the suite it lived in — each fails here,
 * naming what it left uncovered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

/** The repo root, from this file's own location: `<root>/scripts/check-test-coverage.mjs`. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workflow whose steps wire the suites. */
export const WORKFLOW_FILE = ".github/workflows/test.yml";

/** This script, repo-relative — how the workflow must invoke it. */
export const GUARD_SCRIPT = "scripts/check-test-coverage.mjs";

/** The command the workflow's own step must run for this guard to run at all. */
export const GUARD_COMMAND = `node ${GUARD_SCRIPT}`;

/** bun's test discovery: the `.` and `_` forms of both words, js-ish extensions. */
export const TEST_FILE_NAME = /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/;

/** A script name that names a test run: `test`, `test:unit`, … */
const TESTISH_SCRIPT_NAME = /^test(?::|$)/;

/** A word that names a file to execute rather than a bun subcommand. */
const FILEISH = /\.(?:[cm]?[jt]s)$/;

/** Forward-slashed: `relative()` yields `\`-separated paths on Windows. */
export const posix = (path) => path.replaceAll("\\", "/");

/**
 * Remove shell comments from a script: a `#` opens one at a word boundary and
 * outside quotes. A commented-out command is not a command — that is the whole
 * point of reading the script rather than searching its text. Best effort on
 * quoting, which is all a `run:` block needs to be read correctly.
 */
export function stripShellComments(text) {
  let out = "";
  let quote = null;
  let comment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (comment) {
      if (ch === "\n") {
        comment = false;
        out += ch;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      comment = true;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The commands a shell script runs, in order: split on newlines, `&&`, `||` and
 * `;`. Pipes are not split (a piped `bun test` is not how these suites run, and
 * splitting one would break quoted text). `(`/`)` are left in place so a
 * subshell's `cd` can be scoped by the caller.
 */
export function shellCommands(text) {
  return stripShellComments(text)
    .split(/\n|&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Split one command into words, quote-aware (quotes are dropped: `cd "a b"`). */
export function words(segment) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A script name that names a test run. */
export const testishScriptName = (name) => typeof name === "string" && TESTISH_SCRIPT_NAME.test(name);

/** The text between `open` (a `[`) and its matching `]`, quote-aware. */
function balancedBracket(text, open) {
  if (text[open] !== "[") return "";
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** The literal string arguments in a snippet, in order (template holes aside). */
function literalsIn(snippet) {
  const out = [];
  for (let i = 0; i < snippet.length; i += 1) {
    const ch = snippet[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    let value = "";
    for (i += 1; i < snippet.length; i += 1) {
      const c = snippet[i];
      if (c === "\\") {
        value += snippet[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === ch) break;
      value += c;
    }
    out.push(value);
  }
  return out;
}

/**
 * Comments removed from a traced module: a `// spawn("bun", ["test", …])`
 * example in a docblock is not an invocation. The same rule as a `run:` block's
 * shell comments — what is commented out is not what runs — and it keeps a
 * module's own documentation from widening the covered set.
 */
export function stripModuleComments(text) {
  let out = "";
  let quote = null;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (line) {
      if (ch === "\n") {
        line = false;
        out += ch;
      }
      continue;
    }
    if (block) {
      if (ch === "*" && text[i + 1] === "/") {
        block = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      line = true;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      block = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The `bun test` / `bun run <script>` invocations a traced module makes, read
 * from its `spawn`/`execFile` calls: `spawn("bun", ["test", …])`.
 *
 * The argument list is read as literals. Literal paths ARE the run — a ternary
 * whose default is a literal (`… : ["test/"]`) runs that default when CI passes
 * nothing. When the list holds no literal path and does hold a variable
 * (`["test", ...args]`), the roots it runs are UNKNOWN, and `dynamic` says so:
 * the caller fails closed rather than widening the covered set to the cwd.
 */
export function bunTestCalls(moduleText) {
  const calls = [];
  const call = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']bun["']\s*,\s*\[/g;
  for (let match = call.exec(moduleText); match; match = call.exec(moduleText)) {
    const open = moduleText.indexOf("[", match.index + match[0].length - 1);
    const slice = balancedBracket(moduleText, open);
    const literals = literalsIn(slice);
    if (literals[0] === "test") {
      const args = literals.slice(1);
      calls.push({ kind: "test", args, dynamic: args.length === 0 && hasIdentifier(slice) });
    } else if (literals[0] === "run" && literals[1]) {
      calls.push({ kind: "run", name: literals[1] });
    }
  }
  return calls;
}

/** Whether a snippet holds a variable outside its string literals. */
function hasIdentifier(snippet) {
  const withoutLiterals = snippet.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, " ");
  return /[A-Za-z_$][\w$]*/.test(withoutLiterals);
}

/** Repo-relative, forward-slashed; `.` for the repo root itself. */
const relTo = (ctx, abs) => {
  const rel = posix(relative(ctx.rootDir, resolve(abs)));
  return rel === "" ? "." : rel;
};

/** The nearest `package.json` at or above `dir`, within the repo. */
export function nearestPackage(ctx, dir) {
  let current = resolve(dir);
  for (;;) {
    const text = ctx.readFile(join(current, "package.json"));
    if (text !== undefined) {
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch {
        return undefined;
      }
      return { dir: current, scripts: pkg?.scripts ?? {} };
    }
    if (current === ctx.rootDir) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Record one covered root, or a failure if it is not inside the repository. */
function pushRoot(ctx, out, abs, source) {
  const rel = posix(relative(ctx.rootDir, resolve(abs)));
  if (rel === "") {
    out.roots.push({ root: ".", source });
    return;
  }
  if (rel === ".." || rel.startsWith("../")) {
    out.unresolved.push({ source, reason: `test root ${abs} is outside the repository` });
    return;
  }
  out.roots.push({ root: rel, source });
}

/** The roots a `bun test <paths>` invocation covers (its cwd when it names none). */
function addTestRoots(ctx, out, args, cwd, source) {
  const paths = args.filter((arg) => !arg.startsWith("-"));
  const dirs = paths.length ? paths.map((path) => resolve(cwd, path)) : [resolve(cwd)];
  for (const dir of dirs) pushRoot(ctx, out, dir, source);
}

/** Resolve a module the script we are following runs, for the roots it starts. */
function traceFile(ctx, out, file, cwd, source) {
  const key = `file:${file}`;
  if (ctx.seen.has(key) || ctx.depth > ctx.maxDepth) return;
  const text = ctx.readFile(file);
  if (text === undefined) return;
  ctx.seen.add(key);
  ctx.depth += 1;
  const via = `${source} → ${relTo(ctx, file)}`;
  try {
    for (const call of bunTestCalls(stripModuleComments(text))) {
      if (call.kind === "test") {
        if (call.dynamic) {
          out.unresolved.push({
            source: via,
            reason: "a `bun test` whose arguments are a variable — the roots it runs cannot be read, and the guard will not guess",
          });
        } else {
          addTestRoots(ctx, out, call.args, cwd, via);
        }
      } else followScript(ctx, out, call.name, dirname(file), via);
    }
  } finally {
    ctx.depth -= 1;
    ctx.seen.delete(key);
  }
}

/** Follow `bun run <name>` / `npm run <name>` / `npm test` to the roots it runs. */
function followScript(ctx, out, name, cwd, source) {
  const via = `${source} → ${name}`;
  const pkg = nearestPackage(ctx, cwd);
  const body = pkg?.scripts?.[name];
  if (typeof body === "string") {
    const key = `script:${pkg.dir}:${name}`;
    if (ctx.seen.has(key) || ctx.depth > ctx.maxDepth) return;
    ctx.seen.add(key);
    ctx.depth += 1;
    try {
      const res = resolveScript(ctx, body, pkg.dir, via);
      out.roots.push(...res.roots);
      out.unresolved.push(...res.unresolved);
      if (testishScriptName(name) && res.roots.length === 0) {
        out.unresolved.push({
          source: via,
          reason: `\`${name}\` in ${relTo(ctx, pkg.dir)} starts no test root this guard can read`,
        });
      }
    } finally {
      ctx.depth -= 1;
      ctx.seen.delete(key);
    }
    return;
  }
  // Not a script name: `bun run ./file.ts` runs the file.
  const before = out.roots.length;
  traceFile(ctx, out, resolve(cwd, name), cwd, via);
  if (testishScriptName(name) && out.roots.length === before) {
    out.unresolved.push({
      source: via,
      reason: `\`${name}\` is not a script of ${relTo(ctx, cwd)} and starts no test root`,
    });
  }
}

/** Resolve one command segment: a `cd`, a test run, a script, a module. */
function resolveSegment(ctx, segment, cwd, source) {
  const out = { roots: [], unresolved: [], cd: undefined };
  const w = words(segment);
  if (w.length) {
    // A subshell's opener can ride on the first word: `(cd x` / `! cmd`.
    w[0] = w[0].replace(/^[(!{]+/, "");
    w[w.length - 1] = w[w.length - 1].replace(/[)}]+$/, "");
    if (!w[0]) w.shift();
  }
  if (!w.length) return out;
  // Skip a leading wrapper word (`sfw bun test`, `env X=1 bun run test`) so the
  // runner under it is still read. A word that smells like a substitution or a
  // subshell is not a wrapper, and stops the skip.
  let start = 0;
  while (start < w.length && !["cd", "bun", "npm", "node"].includes(w[start])) {
    if (/[()=$`]/.test(w[start])) break;
    start += 1;
  }
  if (start >= w.length) return out;
  const [cmd, sub, ...rest] = w.slice(start);

  // Only a bare `cd` moves the cwd this guard tracks; one behind a wrapper
  // (`env X=1 cd …`) does not count, so the tracked cwd cannot drift on it.
  if (cmd === "cd") {
    if (sub && start === 0) out.cd = resolve(cwd, sub);
    return out;
  }
  if (cmd === "bun" && sub === "test") {
    addTestRoots(ctx, out, rest, cwd, source);
    return out;
  }
  if ((cmd === "bun" && sub === "run" && rest[0]) || (cmd === "npm" && sub === "run" && rest[0])) {
    followScript(ctx, out, rest[0], cwd, source);
    return out;
  }
  if (cmd === "npm" && sub === "test") {
    followScript(ctx, out, "test", cwd, source);
    return out;
  }
  if (cmd === "node" && sub && !sub.startsWith("-")) {
    traceFile(ctx, out, resolve(cwd, sub), cwd, source);
    return out;
  }
  if (cmd === "bun" && sub && !sub.startsWith("-") && FILEISH.test(sub)) {
    traceFile(ctx, out, resolve(cwd, sub), cwd, source);
    return out;
  }
  return out;
}

/** The unquoted `(`/`)` balance of a segment, so a subshell's `cd` can be scoped. */
function parenDelta(segment) {
  let delta = 0;
  let quote = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") delta += 1;
    else if (ch === ")") delta -= 1;
  }
  return delta;
}

/**
 * Resolve a shell script to the covered roots it runs, following `cd` (a
 * subshell's `cd` is scoped to the subshell), script references and traced
 * modules. This is the only path to a root: nothing is accepted from a table.
 */
export function resolveScript(ctx, text, cwd, source) {
  const out = { roots: [], unresolved: [] };
  let current = resolve(cwd);
  const scopes = [];
  let depth = 0;
  for (const segment of shellCommands(text)) {
    const before = depth;
    depth += parenDelta(segment);
    if (before === 0 && depth > 0) scopes.push(current);
    const res = resolveSegment(ctx, segment, current, source);
    if (res.cd) current = res.cd;
    out.roots.push(...res.roots);
    out.unresolved.push(...res.unresolved);
    if (before > 0 && depth === 0) current = scopes.pop() ?? current;
  }
  return out;
}

/** Every root the workflow's steps run, from its `run:` programs. */
export function rootsFromWorkflow(yamlText, ctx) {
  const out = { roots: [], unresolved: [] };
  let doc;
  try {
    doc = yaml.load(yamlText);
  } catch (err) {
    out.unresolved.push({ source: WORKFLOW_FILE, reason: `not valid YAML: ${err.message}` });
    return out;
  }
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      if (typeof step?.run !== "string") return;
      const first = step.run.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      const shown = first.length > 44 ? `${first.slice(0, 41)}…` : first;
      const label = `job ${jobId} → step ${step.name ? JSON.stringify(step.name) : `#${index + 1}`} [${shown}]`;
      const dir = typeof step["working-directory"] === "string" ? step["working-directory"] : ".";
      const res = resolveScript(ctx, step.run, resolve(ctx.rootDir, dir), label);
      out.roots.push(...res.roots);
      out.unresolved.push(...res.unresolved);
    });
  }
  return out;
}

/** Every test file in the repo, repo-relative and sorted. */
export function walkTestFiles(rootDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE_NAME.test(entry.name)) found.push(posix(relative(rootDir, path)));
    }
  };
  walk(rootDir);
  return found.sort();
}

/**
 * The whole check, over an injected filesystem so its own tests can drive it
 * with fixtures: `readFile(abs)` returns a file's text or `undefined`.
 */
export function checkTestCoverage({ rootDir, readFile, listTestFiles }) {
  const ctx = { rootDir: resolve(rootDir), readFile, seen: new Set(), depth: 0, maxDepth: 10 };
  const roots = [];
  const unresolved = [];

  const workflow = readFile(join(ctx.rootDir, WORKFLOW_FILE));
  if (workflow === undefined) {
    unresolved.push({ source: WORKFLOW_FILE, reason: "the workflow that runs the suites is missing" });
  } else {
    const res = rootsFromWorkflow(workflow, ctx);
    roots.push(...res.roots);
    unresolved.push(...res.unresolved);
  }

  const files = [...listTestFiles()].map(posix).sort();
  const byRoot = new Map();
  for (const { root, source } of roots) {
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root).add(source);
  }
  const covered = [...byRoot.keys()].sort();
  const under = (root, file) => root === "." || file === root || file.startsWith(`${root}/`);
  const orphans = files.filter((file) => !covered.some((root) => under(root, file)));
  const emptyRoots = covered.filter((root) => !files.some((file) => under(root, file)));

  const seen = new Set();
  const unique = (entries) =>
    entries.filter((entry) => {
      const key = `${entry.source}\u0000${entry.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    roots: covered.map((root) => ({ root, sources: [...byRoot.get(root)].sort() })),
    unresolved: unique(unresolved),
    orphans,
    emptyRoots,
    files,
    ok: orphans.length === 0 && emptyRoots.length === 0 && unresolved.length === 0,
  };
}

/** The report the CI step prints, and the message a failure needs to be actionable. */
export function formatReport(result) {
  const lines = [];
  lines.push(`test coverage (cli#411): ${result.files.length} test files, ${result.roots.length} covered roots`);
  for (const { root, sources } of result.roots) {
    lines.push(`  ${root}  ← ${sources.join(" | ")}`);
  }
  for (const { source, reason } of result.unresolved) {
    lines.push(`  UNRESOLVED ${source}: ${reason}`);
  }
  if (result.ok) {
    lines.push("OK: every test file is inside a directory a suite CI runs.");
    return lines.join("\n");
  }
  lines.push("FAILED: the test wiring is not what it was.");
  if (result.unresolved.length) {
    lines.push(
      "  A step or script above NAMES a test run but no root could be read from it. Make the\n" +
        "  wiring readable (an explicit `bun test <path>`, or a launcher whose bun arguments are\n" +
        "  literals) — the guard will not guess, and will not pass on a guess.",
    );
  }
  if (result.orphans.length) {
    lines.push(
      "  Test files no suite runs — wire a runner for them (a suite in the root `test` script,\n" +
        "  or a step in .github/workflows/test.yml) or move them under a directory that is run:",
    );
    for (const file of result.orphans) lines.push(`    ${file}`);
  }
  if (result.emptyRoots.length) {
    lines.push("  Covered roots that hold no test file (a `cd` or a path that no longer lands where it did):");
    for (const root of result.emptyRoots) lines.push(`    ${root}`);
  }
  return lines.join("\n");
}

/** 0 when the wiring holds, 1 when it does not. */
export const exitCodeFor = (result) => (result.ok ? 0 : 1);

function main() {
  const result = checkTestCoverage({
    rootDir: REPO,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    listTestFiles: () => walkTestFiles(REPO),
  });
  process.stdout.write(`${formatReport(result)}\n`);
  process.exitCode = exitCodeFor(result);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
