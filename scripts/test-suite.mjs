#!/usr/bin/env node
/**
 * test-suite.mjs — cli#411: run ONE suite of this repo's tests, with a record
 * of what it executed.
 *
 * WHY. The guard that says "every test file is run by a suite CI runs" used to
 * infer coverage from the WIRING — it read the root `test` script and the
 * workflow's `run:` steps as shell programs and worked out which directories
 * they cover. That is an interpreter, and every construct it does not know is
 * either a hole (coverage reported for a command CI never runs) or a false
 * failure: a `:;# bun test ./test` comment, an `&&` inside a quoted string, a
 * `false && bun test`, `echo ./test | xargs bun test`, a step carrying
 * `if: false`, a dropped launcher argument, an `env X=1` prefix it skips, a
 * `--timeout 5000` it reads as a path. There will always be another construct.
 *
 * THE SHAPE NOW: measure what RAN. Every suite CI runs, except the plugin's, is
 * launched through this script, which runs `bun test` with bun's JUnit reporter
 * writing to a known path per suite (the plugin's own launcher sets the same
 * reporter):
 *
 *   test-reports/<suite>.xml   — the JUnit XML: one <testsuite file="…"> per file bun
 *                           executed that registers at least one case (and
 *                           `<testcase file="…">` per case)
 *   test-reports/<suite>.log   — the suite's console output, saved beside the report
 *
 * WHAT EACH FILE IS FOR. The XML is the record the guard reads; nothing else is.
 * The log is the suite's console output kept for the CI record (the step's own
 * log shows it too) — it is not evidence, so a test that prints a line ending in
 * `extra.test.ts:` cannot put a file into the guard's executed set. A file that
 * registers ZERO test cases is named by no report at all; the guard fails on it,
 * naming it, and the failure says how to register one (a `test.skip`/`test.todo`
 * placeholder, or `describe.if`/`test.skipIf` for a platform-only file).
 *
 * THE REPORT IS DELETED FIRST. Before the suite starts, this launcher removes its
 * own suite's XML and log, so a report left by an earlier step or run cannot
 * stand in for the one this run is supposed to write. A run that dies before
 * writing its report therefore leaves none, and the guard fails closed on it.
 *
 * THE REPORT IS SEALED AFTER THE SUITE EXITS (cli#414). Once bun is gone, this
 * launcher writes `test-reports/<suite>.xml.sha256`, holding the SHA-256 of the
 * report's bytes and the suite's own name, then reads it back once to confirm
 * what is on disk is what it wrote. A second suite — a test writing into
 * `test-reports/`, a fixture pointed at the real directory — can no longer
 * replace this suite's report after it ended: the guard (`check-test-reports.mjs`)
 * reads the seal and fails closed when the report's bytes no longer hash to it.
 * The seal is written whether the suite passed or FAILED — a failed suite's
 * partial report is sealed too, so the guard's account of that report stays
 * true. A stale seal is deleted with the report and log before the suite starts,
 * so a seal left by an earlier run cannot vouch for a report this run never made.
 *
 * USAGE
 *   node scripts/test-suite.mjs <suite> [bun test args…]
 *
 * The suite name is the report base name; the args are passed to `bun test`
 * unchanged (e.g. `root-test ./test`). Anything already naming a reporter is
 * left alone, so a caller can choose its own path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repo root, from this file's own location: `<root>/scripts/test-suite.mjs`. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the reports go: `<root>/test-reports`, or TPS_TEST_REPORT_DIR when set. */
export const REPORT_DIR = process.env.TPS_TEST_REPORT_DIR
  ? resolve(process.env.TPS_TEST_REPORT_DIR)
  : join(REPO, "test-reports");

/** The two files a suite writes: its JUnit XML (the guard's record), its console log (the CI record). */
export function reportPaths(suite, reportDir = REPORT_DIR) {
  return {
    xml: join(reportDir, `${suite}.xml`),
    log: join(reportDir, `${suite}.log`),
  };
}

/** The seal a suite writes beside its report: `test-reports/<suite>.xml.sha256`. */
export function sealPath(suite, reportDir = REPORT_DIR) {
  return join(reportDir, `${suite}.xml.sha256`);
}

/**
 * The seal's text: the report's SHA-256 (hex) and the suite name, on one line.
 * This is the format `check-test-reports.mjs` parses and the plugin's own
 * launcher writes (it is self-contained, so the two must agree).
 */
export function sealText(suite, hash) {
  return `${hash}  ${suite}\n`;
}

/**
 * Seal the report this suite just produced: hash its bytes, write the seal, and
 * read it back once so a truncated or unwritten seal fails the step rather than
 * leaving the guard to read a seal that is not there. bun's JUnit report is
 * UTF-8 XML, so hashing the file's bytes and hashing its utf8 text agree.
 */
export function sealReport(suite, reportDir = REPORT_DIR) {
  const { xml } = reportPaths(suite, reportDir);
  const hash = createHash("sha256").update(readFileSync(xml)).digest("hex");
  const expected = sealText(suite, hash);
  const seal = sealPath(suite, reportDir);
  writeFileSync(seal, expected);
  if (readFileSync(seal, "utf8") !== expected) {
    throw new Error(`seal for ${suite} did not read back as written`);
  }
}

/**
 * Run one suite. Resolves with the child's exit code (1 for a signal). The
 * child's output is forwarded to this process AND written to the suite's log,
 * so the CI step's own log still shows the tests. The suite's OWN report and log
 * are deleted first: this run's report must be the one that gets read.
 */
export function runSuite({ suite, args = [], cwd = process.cwd(), env = process.env, reportDir = REPORT_DIR }) {
  const { xml, log } = reportPaths(suite, reportDir);
  const seal = sealPath(suite, reportDir);
  mkdirSync(reportDir, { recursive: true });
  // Stale artifacts go first — a report, log or seal from an earlier step or run
  // must not stand in for this one (the guard reads the XML and its seal; the
  // log is the record).
  rmSync(xml, { force: true });
  rmSync(log, { force: true });
  rmSync(seal, { force: true });
  const reporters = args.filter((arg) => arg.startsWith("--reporter"));
  const bunArgs = [
    "test",
    ...(reporters.length ? [] : ["--reporter=junit", `--reporter-outfile=${xml}`]),
    ...args,
  ];
  const child = spawn("bun", bunArgs, { cwd, env });
  const logStream = createWriteStream(log, { flags: "w" });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });
  return new Promise((resolveExit, rejectExit) => {
    child.on("error", (err) => {
      logStream.end();
      rejectExit(err);
    });
    child.on("close", (code) => {
      // Close the log stream before resolving: the guard reads the report after
      // this process is gone, and a truncated log is a truncated record.
      logStream.end(() => {
        try {
          // Seal whatever bun left, success or failure. A run that died before
          // writing a report leaves none to seal, and the guard fails closed on
          // the missing report.
          if (existsSync(xml)) sealReport(suite, reportDir);
        } catch (err) {
          rejectExit(err);
          return;
        }
        resolveExit(code ?? 1);
      });
    });
  });
}

async function main() {
  const [suite, ...args] = process.argv.slice(2);
  if (!suite) {
    process.stderr.write("usage: node scripts/test-suite.mjs <suite> [bun test args…]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runSuite({ suite, args });
  } catch (err) {
    process.stderr.write(`${suite}: could not launch bun test: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
