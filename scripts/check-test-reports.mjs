#!/usr/bin/env node
/**
 * check-test-reports.mjs — cli#411: every test file on disk must be shown
 * EXECUTED by a JUnit report a suite CI runs actually wrote.
 *
 * WHAT CHANGED, AND WHY. The previous guard inferred coverage from the WIRING:
 * it parsed the root `test` script and the workflow's `run:` steps as shell
 * programs and derived the directories they cover. A shell interpreter, it
 * reported coverage for commands CI never runs — a `:;# bun test ./test`
 * comment, an `&&` inside quotes, `false && bun test`, `echo ./test | xargs bun
 * test`, a step with `if: false`, a dropped launcher argument, an `env X=1`
 * prefix, `--timeout 5000` read as a root — and each of those is one more
 * construct to teach it. The set of constructs has no end, so this guard no
 * longer asks what the wiring SAYS. It asks what ran.
 *
 * THE SHAPE:
 *
 *  1. Every suite CI runs writes a JUnit report to a known path per suite
 *     (`test-reports/<suite>.xml`), through `scripts/test-suite.mjs`; the plugin's
 *     launcher sets the same flags for its own run. Each launcher DELETES its own
 *     suite's files before that suite starts, so a report left by an earlier step
 *     or run cannot stand in for this one. Beside each report is the suite's
 *     console output, saved for the CI record (`test-reports/<suite>.log`) — this
 *     script does not read it.
 *  2. Each launcher SEALS its report as soon as the suite exits (cli#414): it
 *     writes `test-reports/<suite>.xml.sha256` holding the SHA-256 of the report's
 *     bytes and the suite's own name, then reads it back once. This script
 *     verifies the seal BEFORE it uses the report: a missing seal, a seal naming
 *     another suite, a malformed seal, or a hash that does not match the report's
 *     current bytes fails closed, naming the suite. That is what stops a LATER
 *     suite — a test writing into `test-reports/`, a fixture pointed at the real
 *     directory — from replacing an EARLIER suite's report with another valid
 *     JUnit file the guard would otherwise read.
 *  3. This script reads every report a suite MUST have written, collects the
 *     test FILES those reports show executed, discovers the test files on disk
 *     (every form bun discovers), and fails naming each discovered file that no
 *     report shows executed.
 *  4. It FAILS CLOSED: a required suite whose report is missing, unreadable, or
 *     empty (no `<testsuite>` at all) fails the check, and so does one whose seal
 *     is missing or does not match, because a suite that measured nothing — or
 *     whose measurement was replaced — must never read as a suite that measured
 *     everything.
 *  5. It is its own step and runs LAST in the job with `if: always()`, so a
 *     suite step failing does not skip it — and it is not a clause of any suite,
 *     so removing a suite from the wiring cannot take the guard down with it.
 *
 * THE EXECUTED SET COMES FROM THE JUNIT REPORTS AND NOTHING ELSE. bun writes
 * those reports; a test's own stdout and stderr cannot put a file into them. An
 * earlier revision ALSO read each suite's console log and matched bun's per-file
 * header lines (`extra.test.ts:`), to cover a file bun executed whose JUnit
 * report names it nowhere — a file with ZERO test cases appears in no
 * `<testsuite>` and no `<testcase>`. That signal was forgeable: a test that
 * PRINTED a line ending in `extra.test.ts:` put a file into the executed set
 * that never ran. So it is gone. A discovered test file that no report names
 * now fails — which is exactly what a zero-case file looks like — and the
 * failure names the file and says what to do about it.
 *
 * WHAT IT DOES NOT CHECK: whether the tests PASSED. A suite whose tests fail but
 * which runs to the end still writes a complete report, and this guard passes it
 * when every discovered file is accounted for; the job fails through that suite's
 * own step. A run that dies before bun writes its report leaves none, and the
 * guard fails closed on that. What this guard holds is which files RAN.
 *
 * A detective, not a boundary: a pull request can edit this script and the
 * wiring together, and the boundary there is review of the diff. What it holds
 * is that coverage cannot go quiet.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repo root, from this file's own location: `<root>/scripts/check-test-reports.mjs`. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the suites write their reports: `<root>/test-reports`, or TPS_TEST_REPORT_DIR. */
export const REPORT_DIR = process.env.TPS_TEST_REPORT_DIR
  ? resolve(process.env.TPS_TEST_REPORT_DIR)
  : join(REPO, "test-reports");

/**
 * The seal a suite writes beside its report when it exits (cli#414):
 * `test-reports/<suite>.xml.sha256`, holding the report's SHA-256 and the suite
 * name. `scripts/test-suite.mjs` and the plugin's own self-contained launcher
 * both write this format; this script is its reader.
 */
export const sealPath = (suite, reportDir = REPORT_DIR) => join(reportDir, `${suite}.xml.sha256`);

/** SHA-256 (hex) of a report's bytes; a string is hashed as its utf8 encoding. */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parse a seal's text — one line of `<64-hex>  <suite>` — into its parts, or
 * `undefined` when it is not a seal at all. A malformed seal fails closed, so
 * nothing permissive happens here: the hash must be full lowercase hex and the
 * suite a bare token.
 */
export function parseSeal(text) {
  if (typeof text !== "string") return undefined;
  const match = /^([0-9a-f]{64})[ \t]+(\S+)\s*$/.exec(text);
  if (!match) return undefined;
  return { sha256: match[1], suite: match[2] };
}

/**
 * The suites CI must run, each with the directory its `bun test` runs in (the
 * JUnit `file` attributes are relative to the runner's cwd) and the report it
 * must leave behind. Every entry here is REQUIRED: a missing report fails.
 */
export const REQUIRED_SUITES = [
  { suite: "agent", cwd: "packages/agent" },
  { suite: "cli", cwd: "packages/cli" },
  { suite: "pi-tps-mail", cwd: "packages/pi-tps-mail" },
  { suite: "root-test", cwd: "." },
  { suite: "plugin", cwd: "plugins/openclaw-tps-mail" },
];

/**
 * bun's test discovery, verified against bun 1.3.10: a file whose name ends in
 * `.test`, `_test`, `.spec` or `_spec` before a js-ish extension. `foo.test.helper.ts`
 * and `foo-spec.ts` are NOT discovered; `dist/compiled.test.js` and
 * `.dotfile.test.ts` ARE.
 */
export const TEST_FILE_NAME = /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/;

/** Directories bun never descends into, from its own discovery. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Forward-slashed: `relative()` yields `\`-separated paths on Windows. */
export const posix = (path) => path.replaceAll("\\", "/");

/**
 * Every test file under `rootDir`, repo-relative and sorted. This mirrors bun's
 * discovery: dot-directories are skipped (bun 1.3.10 does not descend into
 * them), dot-FILES are not, `node_modules` is skipped at any depth, and `dist/`
 * is NOT skipped (bun discovers `dist/compiled.test.js`).
 */
export function discoverTestFiles(rootDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Any failure to read a directory (EACCES, EMFILE, a directory that
      // vanished mid-walk, a missing root) means discovery did not see the whole
      // tree, and a partial discovery can pass a guard that should fail. So it
      // throws and the guard fails closed; a transient failure costs a re-run.
      throw new Error(
        `test discovery could not read ${posix(relative(rootDir, dir)) || "."} (${err?.code ?? err?.message ?? err}); refusing to report coverage from a partial walk`,
      );
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE_NAME.test(entry.name)) found.push(posix(relative(rootDir, path)));
    }
  };
  walk(rootDir);
  return found.sort();
}

/** One attribute of a tag's text: `<testsuite name="x" file="y">` → `y`. */
function attr(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : undefined;
}

/**
 * The files a JUnit report names as executed, plus what the report SAYS it ran.
 * `testsuites` counts the `<testsuite>` elements (bun emits one per executed
 * file that has at least one test case, plus one per `describe`); zero of them
 * means the suite executed nothing, and the caller fails closed.
 */
export function parseJunit(text) {
  const testsuites = [];
  const testcases = [];
  for (const match of text.matchAll(/<testsuite\b[^>]*>/g)) {
    const file = attr(match[0], "file");
    if (file) testsuites.push({ file, tests: Number(attr(match[0], "tests") ?? 0) });
  }
  for (const match of text.matchAll(/<testcase\b[^>]*>/g)) {
    const file = attr(match[0], "file");
    if (file) testcases.push({ file });
  }
  return { testsuites, testcases };
}

/**
 * The whole check, over injected reads so its own tests can drive it with
 * fixtures. `readFile(abs)` returns a file's text, or `undefined` if it is not
 * there. Returns what each suite contributed, the executed set, the discovered
 * set and the failures.
 */
export function checkTestReports({
  rootDir = REPO,
  reportDir = REPORT_DIR,
  suites = REQUIRED_SUITES,
  readFile,
  discover = discoverTestFiles,
}) {
  const root = resolve(rootDir);
  const executed = new Set();
  const suiteResults = [];
  const failures = [];

  for (const { suite, cwd } of suites) {
    const xml = join(reportDir, `${suite}.xml`);
    const seal = sealPath(suite, reportDir);
    const suiteCwd = resolve(root, cwd);
    const text = readFile(xml);
    const files = new Set();
    let state = "ran";
    if (text === undefined) {
      failures.push({
        suite,
        kind: "missing-report",
        detail: `no JUnit report at ${posix(relative(root, xml))} — the suite did not run, or did not write one`,
      });
      state = "missing";
    } else {
      // The seal is verified BEFORE the report is used (cli#414). A report whose
      // bytes no longer hash to its seal may have been replaced after the suite
      // ended, so it must not contribute a single file to the executed set.
      const sealRead = readFile(seal);
      const parsedSeal = sealRead === undefined ? undefined : parseSeal(sealRead);
      const sealRel = posix(relative(root, seal));
      let sealed = false;
      if (sealRead === undefined) {
        failures.push({
          suite,
          kind: "no-seal",
          detail: `${sealRel} is missing — the suite ended without sealing its report, so the report cannot be trusted to be the one it produced`,
        });
        state = "unsealed";
      } else if (parsedSeal === undefined) {
        failures.push({
          suite,
          kind: "malformed-seal",
          detail: `${sealRel} is not a seal (<sha256>  <suite>) — a seal that cannot be read fails closed`,
        });
        state = "unsealed";
      } else if (parsedSeal.suite !== suite) {
        failures.push({
          suite,
          kind: "wrong-suite-seal",
          detail: `the seal at ${sealRel} names suite "${parsedSeal.suite}", not "${suite}"`,
        });
        state = "unsealed";
      } else if (parsedSeal.sha256 !== sha256Hex(text)) {
        failures.push({
          suite,
          kind: "changed-after-suite",
          detail: `the report at ${posix(relative(root, xml))} changed after the suite ended — its bytes no longer match the seal at ${sealRel}`,
        });
        state = "unsealed";
      } else {
        sealed = true;
      }
      const parsed = parseJunit(text);
      if (!sealed) {
        // Unsealed: no file from this report enters the executed set.
      } else if (!text.includes("<testsuites")) {
        failures.push({
          suite,
          kind: "unreadable-report",
          detail: `${posix(relative(root, xml))} is not a JUnit report (no <testsuites>) — a report that cannot be read fails closed`,
        });
        state = "unreadable";
      } else if (parsed.testsuites.length === 0) {
        failures.push({
          suite,
          kind: "empty-report",
          detail: `${posix(relative(root, xml))} shows no executed file (no <testsuite>) — an empty report fails closed`,
        });
        state = "empty";
      } else {
        for (const entry of [...parsed.testsuites, ...parsed.testcases]) {
          files.add(posix(relative(root, resolve(suiteCwd, entry.file))));
        }
      }
    }
    for (const file of files) executed.add(file);
    suiteResults.push({ suite, cwd, state, files: files.size });
  }

  const discovered = discover(root);
  const orphans = discovered.filter((file) => !executed.has(file));
  for (const file of orphans) {
    failures.push({
      suite: undefined,
      kind: "unexecuted",
      detail:
        `${file} is a test file, and no JUnit report shows a suite executing it: either no suite ran it,\n` +
        `  or it registers ZERO test cases — bun's report names a file only when it has at least one case.\n` +
        `  A test file must register at least one case: test.skip or test.todo for a placeholder, or\n` +
        `  describe.if / test.skipIf for a platform-only file, so its cases show as skipped.`,
    });
  }

  return {
    suites: suiteResults,
    executed: [...executed].sort(),
    discovered,
    orphans,
    failures,
    ok: failures.length === 0,
  };
}

/** The report the CI step prints. Every failure line names what to fix. */
export function formatReport(result) {
  const lines = [];
  lines.push(
    `test coverage (cli#411): ${result.discovered.length} test files discovered, ` +
      `${result.executed.length} shown executed by ${result.suites.length} suites`,
  );
  for (const { suite, cwd, state, files } of result.suites) {
    const where = cwd === "." ? "the repo root" : cwd;
    const how =
      state === "ran"
        ? `${files} test file${files === 1 ? "" : "s"}`
        : state === "missing"
          ? "NO REPORT"
          : state === "unsealed"
            ? "UNSEALED REPORT"
            : state === "unreadable"
              ? "UNREADABLE REPORT"
              : "EMPTY REPORT";
    lines.push(`  ${suite.padEnd(12)} [${where}] ${how}`);
  }
  if (result.ok) {
    lines.push("OK: every test file on disk is shown executed by a suite CI runs.");
    return lines.join("\n");
  }
  lines.push("FAILED: a test file is not covered by what CI ran.");
  for (const failure of result.failures) {
    lines.push(`  ${failure.detail}`);
  }
  lines.push(
    "  Either wire a runner for it (a suite in the root `test` script, or a step in\n" +
      "  .github/workflows/test.yml), or give it at least one case. And if a suite did not run\n" +
      "  at all, fix that first: a missing report fails closed, so a suite that never ran cannot\n" +
      "  read as a suite that covered everything.",
  );
  return lines.join("\n");
}

/** 0 when every discovered file is shown executed, 1 when it is not. */
export const exitCodeFor = (result) => (result.ok ? 0 : 1);

function main() {
  const result = checkTestReports({
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
  process.stdout.write(`${formatReport(result)}\n`);
  process.exitCode = exitCodeFor(result);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
