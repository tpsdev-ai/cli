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
 * `test-reports/`, a fixture pointed at the real directory — that replaces this
 * suite's report after it ended is DETECTED: the guard (`check-test-reports.mjs`)
 * reads the seal and fails closed when the report's bytes no longer hash to it.
 * THE LIMIT, STATED: the seal defeats an ACCIDENTAL overwrite by a later step in
 * the same job. It is not a defence against code in the same job that rewrites
 * the report and the seal together (a launcher re-run for the same suite name
 * does exactly that): that code shares the job's filesystem, and the job's
 * credential separation is the control for it.
 * The seal is written whether the suite passed or FAILED — a failed suite's
 * partial report is sealed too, so the guard's account of that report stays
 * true. A stale seal is deleted with the report and log before the suite starts,
 * so a seal left by an earlier run cannot vouch for a report this run never made.
 *
 * HOME ISOLATION (cli#430). The child runs with HOME and TPS_TEST_ROOT pointed
 * at a fresh throwaway root, TMPDIR/TMP/TEMP and bun's transpiler cache inside
 * it, and an ALLOWLISTED environment: only the few named, path-free variables in
 * scripts/test-home-guard.mjs `PASSED_ENV` (plus PATH) are passed on, and every
 * other inherited variable is dropped (the launcher prints the dropped NAMES,
 * never values). A `--preload` aborts a child whose os.homedir() is outside that
 * root, or whose root is or contains the account's home or is not one a launcher
 * made. Before creating or deleting anything, the launcher refuses a suite name
 * that is not a plain file-name token, a temp dir inside an operator home, a
 * report dir that is or contains an operator home, and a report dir or
 * report/log/seal path inside ~/.tps, ~/.flair, ~/agents or ~/.config (or a
 * report path that is a symlink) — the default report dir included. It fails
 * the lane on a recorded metadata difference in the ~/.tps of the HOME it runs
 * under — a diagnostic, not an OS boundary. These are launch-time checks; the
 * launcher process itself runs under the caller's environment.
 *
 * USAGE
 *   node scripts/test-suite.mjs <suite> [bun test args…]
 *
 * The suite name is the report base name; the args are passed to `bun test`
 * unchanged (e.g. `root-test ./test`). The launcher owns the report
 * destination: a caller-supplied `--reporter-outfile`, in either the
 * `--reporter-outfile=<path>` or the `--reporter-outfile <path>` form, is
 * refused before anything is created or deleted (TPS_TEST_REPORT_DIR moves the
 * reports). A caller's `--reporter=<name>` is passed on, and the launcher then
 * adds none of its own reporter flags.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IsolationRefusal,
  assertNoReporterOutfile,
  assertReportPaths,
  assertSuiteName,
  assertTestDestinations,
  createIsolatedRoot,
  describeLeak,
  diffSnapshots,
  isolatedChildEnv,
  snapshotTps,
} from "./test-home-guard.mjs";

/** The repo root, from this file's own location: `<root>/scripts/test-suite.mjs`. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The preload that aborts a run which did not come up under the isolated root
 * (cli#430). Passed to `bun --preload`, so it loads before any test module.
 */
export const HOME_ISOLATION_PRELOAD = join(REPO, "scripts", "home-isolation-preload.ts");

/** The in-repo report directory, used unless TPS_TEST_REPORT_DIR is set. */
export const DEFAULT_REPORT_DIR = join(REPO, "test-reports");

/** Where the reports go: `<root>/test-reports`, or TPS_TEST_REPORT_DIR when set. */
export const REPORT_DIR = process.env.TPS_TEST_REPORT_DIR
  ? resolve(process.env.TPS_TEST_REPORT_DIR)
  : DEFAULT_REPORT_DIR;

/**
 * The two files a suite writes: its JUnit XML (the guard's record), its console
 * log (the CI record). The suite name is checked first (cli#430): it becomes a
 * file name, so it may not carry a path separator or `..`.
 */
export function reportPaths(suite, reportDir = REPORT_DIR) {
  assertSuiteName(suite);
  return {
    xml: join(reportDir, `${suite}.xml`),
    log: join(reportDir, `${suite}.log`),
  };
}

/** The seal a suite writes beside its report: `test-reports/<suite>.xml.sha256`. */
export function sealPath(suite, reportDir = REPORT_DIR) {
  assertSuiteName(suite);
  return join(reportDir, `${suite}.xml.sha256`);
}

/**
 * The seal's text: the report's SHA-256 (hex) and the suite name, on one line.
 * This is the format `check-test-reports.mjs` parses and the plugin's own
 * launcher writes (it spells the format out rather than importing it, so the
 * two must agree).
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
/** A seal that could not be written or read back — reported as such, never as a launch failure. */
export class SealError extends Error {}

export function sealReport(suite, reportDir = REPORT_DIR) {
  const { xml } = reportPaths(suite, reportDir);
  const hash = createHash("sha256").update(readFileSync(xml)).digest("hex");
  const expected = sealText(suite, hash);
  const seal = sealPath(suite, reportDir);
  // cli#430: never write through whatever sits at the seal path now. Remove it
  // (rm unlinks a symlink, never its target) and create the file exclusively.
  rmSync(seal, { force: true });
  writeFileSync(seal, expected, { flag: "wx" });
  if (readFileSync(seal, "utf8") !== expected) {
    throw new SealError(`seal for ${suite} did not read back as written`);
  }
}

/**
 * Run one suite. Resolves with the child's exit code (1 for a signal). The
 * child's output is forwarded to this process AND written to the suite's log,
 * so the CI step's own log still shows the tests. The suite's OWN report and log
 * are deleted first: this run's report must be the one that gets read.
 */
export function runSuite({
  suite,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  reportDir = REPORT_DIR,
  tempBase = tmpdir(),
}) {
  // cli#430: refuse BEFORE any filesystem call. The suite name becomes the
  // report's file name (reportPaths/sealPath check it too). Then every
  // destination, the default report dir included: the temp dir (where the
  // throwaway root is created and later removed) must be outside every operator
  // home; the report dir is resolved (symlinks followed) and refused when it
  // resolves at or above an operator home or inside ~/.tps, ~/.flair, ~/agents
  // or ~/.config; this suite's report, log and seal files (deleted now, written
  // later) must not be symlinks or resolve inside those four. Throws
  // IsolationRefusal.
  assertSuiteName(suite);
  const { xml, log } = reportPaths(suite, reportDir);
  const seal = sealPath(suite, reportDir);
  assertTestDestinations({ env, tempBase, reportDir, paths: [xml, log, seal] });

  // cli#430: the launcher owns the report destination. A caller-supplied
  // --reporter-outfile is refused before anything is created, by the shared
  // check (--reporter=<name> stays allowed). Thrown, not exited on, so a direct
  // caller of runSuite can catch it; main() prints it.
  assertNoReporterOutfile(args);

  // cli#430: the metadata snapshot of the ~/.tps under the HOME this launcher
  // runs under, taken before this launcher writes anything. A DIAGNOSTIC: the
  // lane fails on a recorded metadata difference at the end (path, size, mtime,
  // ctime, inode — never contents); the control is the HOME redirection and the
  // allowlisted environment below (scripts/test-home-guard.mjs).
  const guardHome = env.HOME || homedir();
  const tpsBefore = snapshotTps(guardHome);

  mkdirSync(reportDir, { recursive: true });
  // Stale artifacts go first — a report, log or seal from an earlier step or run
  // must not stand in for this one (the guard reads the XML and its seal; the
  // log is the record).
  rmSync(xml, { force: true });
  rmSync(log, { force: true });
  rmSync(seal, { force: true });
  // The log is created exclusively, before any test code runs.
  const logStream = createWriteStream("", { fd: openSync(log, "wx") });

  // cli#430: isolate HOME for the whole lane. The suite used to resolve the
  // real ~/.tps (identity, credentials, auth, agents, run, mail, outbox) from the
  // operator HOME. Create a throwaway root and give the child an ALLOWLISTED
  // environment: HOME and TPS_TEST_ROOT at the root, TMPDIR and bun's cache
  // inside it, and only the named inherited variables, each path-free except
  // PATH. Pass the isolation PRELOAD so a child that did not come up under a
  // launcher-made root aborts before any test module loads.
  const { root: isoRoot, token } = createIsolatedRoot(tempBase);
  mkdirSync(join(isoRoot, ".tps", "mail"), { recursive: true });
  mkdirSync(join(isoRoot, "keys"), { recursive: true });
  const { env: childEnv, dropped } = isolatedChildEnv(env, { root: isoRoot, token });
  if (dropped.length > 0) {
    process.stderr.write(`tps-test-${suite}: not passed to the tests (not on the allowlist): ${dropped.join(", ")}\n`);
  }

  const reporters = args.filter((arg) => arg.startsWith("--reporter"));
  const bunArgs = [
    `--preload=${HOME_ISOLATION_PRELOAD}`,
    "test",
    ...(reporters.length ? [] : ["--reporter=junit", `--reporter-outfile=${xml}`]),
    ...args,
  ];
  const child = spawn("bun", bunArgs, { cwd, env: childEnv });
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
      let exitCode = code ?? 1;
      // cli#430: compare the ~/.tps snapshot before/after. A recorded metadata
      // difference is reported and fails the lane even when every test passed (a
      // diagnostic — see scripts/test-home-guard.mjs for what it can miss).
      const changed = diffSnapshots(tpsBefore, snapshotTps(guardHome));
      if (changed.length > 0) {
        process.stderr.write(`\n${describeLeak(guardHome, changed)}\n`);
        exitCode = 1;
      }
      // Remove the throwaway root (a leaked temp root is preferable to masking
      // a result, so failures here are best-effort).
      if (process.env.TPS_TEST_KEEP_ROOT === "1") {
        console.log(`tps-test-${suite}: kept isolated root ${isoRoot}`);
      } else {
        try {
          rmSync(isoRoot, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      // Close the log stream before resolving: the guard reads the report after
      // this process is gone, and a truncated log is a truncated record.
      logStream.end(() => {
        // cli#430: the seal is a write too — re-check the report dir and the
        // report and seal paths (a test ran in between) before sealing.
        try {
          assertReportPaths({ env, reportDir, paths: [xml, seal] });
        } catch (err) {
          if (!(err instanceof IsolationRefusal)) {
            rejectExit(err);
            return;
          }
          process.stderr.write(`${suite}: not sealing the report: ${err.message}\n`);
          resolveExit(1);
          return;
        }
        try {
          // Seal whatever bun left, success or failure. A run that died before
          // writing a report leaves none to seal, and the guard fails closed on
          // the missing report.
          if (existsSync(xml)) sealReport(suite, reportDir);
        } catch (err) {
          rejectExit(err);
          return;
        }
        resolveExit(exitCode);
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
    if (err instanceof IsolationRefusal) {
      process.stderr.write(`${suite}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const what = err instanceof SealError ? "could not seal the report" : "could not launch bun test";
    process.stderr.write(`${suite}: ${what}: ${err.message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Whether this module is the process entry point (cli#475). Compared by REAL
 * path: `import.meta.url` is resolved through symlinks while `process.argv[1]`
 * keeps the path it was invoked with, so comparing them as given made the
 * launcher a silent no-op — exit 0, no suite run — through a symlinked path.
 * An unresolvable argv[1] is not "not the entry point": it throws, rather than
 * exit 0 having run nothing.
 */
function isEntryPoint() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return realpathSync(invoked) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  await main();
}
