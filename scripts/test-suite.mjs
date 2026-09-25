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
 * THE SHAPE NOW: measure what RAN. Every suite CI runs is launched through this
 * script, which runs `bun test` with bun's JUnit reporter writing to a known
 * path per suite:
 *
 *   test-reports/<suite>.xml   — the JUnit XML: one <testsuite file="…"> per file bun
 *                           executed (and `<testcase file="…">` per case)
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
 * USAGE
 *   node scripts/test-suite.mjs <suite> [bun test args…]
 *
 * The suite name is the report base name; the args are passed to `bun test`
 * unchanged (e.g. `root-test ./test`). Anything already naming a reporter is
 * left alone, so a caller can choose its own path.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
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

/**
 * Run one suite. Resolves with the child's exit code (1 for a signal). The
 * child's output is forwarded to this process AND written to the suite's log,
 * so the CI step's own log still shows the tests. The suite's OWN report and log
 * are deleted first: this run's report must be the one that gets read.
 */
export function runSuite({ suite, args = [], cwd = process.cwd(), env = process.env, reportDir = REPORT_DIR }) {
  const { xml, log } = reportPaths(suite, reportDir);
  mkdirSync(reportDir, { recursive: true });
  // Stale artifacts go first — a report or log from an earlier step or run must
  // not stand in for this one (the guard reads the XML; the log is the record).
  rmSync(xml, { force: true });
  rmSync(log, { force: true });
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
      logStream.end(() => resolveExit(code ?? 1));
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
