#!/usr/bin/env node
/**
 * run-tests.mjs — the isolated launcher for the openclaw-github-review suite.
 *
 * WHAT IT DOES. It creates a fresh throwaway root and launches `bun test` with
 * HOME and TPS_TEST_ROOT pointing at it. The child's environment is an
 * ALLOWLIST (cli#430, scripts/test-home-guard.mjs `isolatedChildEnv`): the
 * `PASSED_ENV` variables whose values are path-free, and PATH; HOME and
 * TPS_TEST_ROOT at the root; TPS_TEST_ROOT_TOKEN, the token of the marker this
 * launcher wrote in the root; TMPDIR/TMP/TEMP and bun's transpiler cache inside
 * the root; and TPS_LANE_NODE (below). The bun test preload
 * (test/preload-guard.ts) aborts a run whose os.homedir() is not under that
 * root, whose root is or contains the account's home, or whose root has no
 * marker matching TPS_TEST_ROOT_TOKEN — before any test module loads.
 *
 * Before creating or deleting anything, this launcher makes the shared checks
 * from scripts/test-home-guard.mjs (cli#438). An operator home is the HOME it
 * started with or the account's home. The temp dir is refused when it resolves
 * inside an operator home. The report directory — the default test-reports/
 * included — is resolved (symlinks followed) and refused when it resolves at or
 * above an operator home or inside ~/.tps, ~/.flair, ~/agents or ~/.config; the
 * report, log and seal files themselves must not be symlinks or resolve inside
 * those four. A caller-supplied `--reporter-outfile`, in either the `=` or the
 * space form, is refused. It fails the lane on a recorded metadata difference in
 * the ~/.tps of the HOME it started with — a diagnostic. These are launch-time
 * checks, not an OS boundary (cli#434); this launcher process itself runs under
 * the caller's environment.
 *
 * USAGE
 *   node scripts/run-tests.mjs [bun test args…]   # default: `test/`
 *   TPS_TEST_KEEP_ROOT=1 node scripts/run-tests.mjs   # keep the temp root
 *
 * THE BUILD. The gateway-boundary lane loads the BUILT plugin (dist/) with
 * OpenClaw's own plugin loader, and the latch-admin test runs the built command.
 * When the plugin's TypeScript compiler (node_modules/typescript/bin/tsc) is
 * there, this launcher builds first and refuses to run if the build fails. When
 * it is not, the launcher skips the build only if neither node_modules/ nor
 * dist/ exists in the plugin directory — the tree the cli lane has when the
 * repo's guard tests run this launcher, before the job's `npm ci` step for this
 * plugin — and otherwise refuses to run, naming the missing compiler.
 *
 * cli#411: the run writes a JUnit report (test-reports/github-review.xml, bun
 * --reporter=junit) — the record the coverage guard reads — and the suite's
 * console output beside it (test-reports/github-review.log), both at the repo
 * root, or under TPS_TEST_REPORT_DIR when set. A caller's `--reporter=<name>` is
 * passed on (this launcher then adds none of its own).
 *
 * cli#414: once bun exits, this launcher SEALS the report —
 * test-reports/github-review.xml.sha256, holding the report's SHA-256 and the
 * suite name "github-review", read back once — so the coverage guard can detect
 * a later overwrite of the report alone. The seal format is the one
 * check-test-reports.mjs parses and scripts/test-suite.mjs writes; it is spelled
 * out here rather than imported, so the two must agree. A stale seal is deleted
 * with the report and log before the run starts.
 * The limit, stated: the seal defeats an ACCIDENTAL overwrite by a later step in
 * the same job; it is not a defence against code in the same job that rewrites
 * the report and the seal together — that code shares the job's filesystem, and
 * the job's credential separation is the control for it.
 *
 * TPS_LANE_NODE: the gateway-boundary lane runs OpenClaw in a separate node
 * process (its plugin loader needs node:sqlite, which bun lacks); it uses the
 * node that launched this suite.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IsolationRefusal,
  assertNoReporterOutfile,
  assertReportPaths,
  assertTestDestinations,
  createIsolatedRoot,
  describeLeak,
  diffSnapshots,
  isolatedChildEnv,
  snapshotTps,
} from "../../../scripts/test-home-guard.mjs";

const SUITE = "github-review";
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.env.TPS_TEST_KEEP_ROOT === "1";

// cli#411: test-reports/<suite>.xml + .log, beside the other suites' reports.
const repoRoot = resolve(pluginDir, "..", "..");
const reportDir = process.env.TPS_TEST_REPORT_DIR
  ? resolve(process.env.TPS_TEST_REPORT_DIR)
  : join(repoRoot, "test-reports");
const reportXml = join(reportDir, `${SUITE}.xml`);
const reportLog = join(reportDir, `${SUITE}.log`);
const reportSeal = join(reportDir, `${SUITE}.xml.sha256`);
const tempBase = tmpdir();

// cli#438 (cli#430's checks): refuse BEFORE creating or deleting anything — the
// default report dir included. The temp dir (the throwaway root is created and
// removed there) must be outside every operator home; the report dir is resolved
// (symlinks followed) and refused when it resolves at or above an operator home
// or inside ~/.tps, ~/.flair, ~/agents or ~/.config; this run's report, log and
// seal files (deleted now, written later) must not be symlinks or resolve inside
// those four. The launcher owns the report destination, so a caller-supplied
// --reporter-outfile is refused too (the shared check scripts/test-suite.mjs
// makes).
try {
  assertTestDestinations({ env: process.env, tempBase, reportDir, paths: [reportXml, reportLog, reportSeal] });
  assertNoReporterOutfile(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof IsolationRefusal)) throw err;
  console.error(`openclaw-github-review tests: ${err.message}`);
  process.exit(1);
}

// cli#430: the metadata snapshot of the ~/.tps under the HOME this launcher
// started with, taken before anything is written. A DIAGNOSTIC: the run fails
// on a recorded metadata difference at the end (path, size, mtime, ctime, inode
// — never contents).
const guardHome = process.env.HOME || homedir();
const tpsBefore = snapshotTps(guardHome);

mkdirSync(reportDir, { recursive: true });
// Stale artifacts go first: this run's report must be the one the guard reads,
// and this run's seal must vouch for it (not a seal left by an earlier run).
rmSync(reportXml, { force: true });
rmSync(reportLog, { force: true });
rmSync(reportSeal, { force: true });
// The log is created exclusively, before any test code runs.
const logStream = createWriteStream("", { fd: openSync(reportLog, "wx") });

// THE BUILD (see the header). With tsc: build, and refuse a failed build.
// Without it: skip the build only when neither node_modules/ nor dist/ exists
// (anything at either path counts, a dangling symlink included); otherwise
// refuse, naming what is missing.
const nodeModules = join(pluginDir, "node_modules");
const dist = join(pluginDir, "dist");
const tsc = join(nodeModules, "typescript", "bin", "tsc");
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
if (existsSync(tsc)) {
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: pluginDir, stdio: "inherit" });
  if (build.status !== 0) {
    logStream.end();
    console.error(`openclaw-github-review tests: build failed (exit ${build.status}); refusing to run the suite`);
    process.exit(1);
  }
} else {
  const found = [nodeModules, dist].filter(present);
  if (found.length > 0) {
    logStream.end();
    console.error(
      `openclaw-github-review tests: refusing to run the suite — the TypeScript compiler ${tsc} is missing, but ${found.join(" and ")} ${found.length > 1 ? "exist" : "exists"}, so the build cannot run. The build is skipped only when neither node_modules/ nor dist/ exists. Install the plugin's devDependencies (npm ci in ${pluginDir}) and re-run.`,
    );
    process.exit(1);
  }
  console.error(`openclaw-github-review tests: neither ${nodeModules} nor ${dist} exists: running the requested tests without a build`);
}

// The throwaway root (realpath'd: on macOS /tmp is a symlink to /private/tmp,
// and the guards compare realpaths).
const { root, token } = createIsolatedRoot(tempBase);

// Child env: the ALLOWLIST (cli#430) plus the values this launcher sets.
const { env, dropped } = isolatedChildEnv(process.env, { root, token, extra: { TPS_LANE_NODE: process.execPath } });
if (dropped.length > 0) {
  console.error(`openclaw-github-review tests: not passed to the tests (not on the allowlist): ${dropped.join(", ")}`);
}

console.log(`openclaw-github-review tests: isolated root ${root}`);

const passthrough = process.argv.slice(2);
const args = ["test", ...(passthrough.length ? passthrough : ["test/"])];
// A caller-supplied --reporter is the ONE accepted reason for no JUnit report.
const callerReporter = args.some((a) => a.startsWith("--reporter"));
if (!callerReporter) {
  args.push("--reporter=junit", `--reporter-outfile=${reportXml}`);
}
const child = spawn("bun", args, { cwd: pluginDir, env, stdio: ["inherit", "pipe", "pipe"] });

child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});
child.on("error", (err) => {
  console.error(`openclaw-github-review tests: could not launch bun: ${err.message}`);
  process.exit(1);
});
child.on("close", (code, signal) => {
  // cli#430: compare the ~/.tps snapshot before/after; a recorded metadata
  // difference is reported and fails the lane even when every test passed.
  let exitCode = signal ? 1 : (code ?? 1);
  const changed = diffSnapshots(tpsBefore, snapshotTps(guardHome));
  if (changed.length > 0) {
    process.stderr.write(`\n${describeLeak(guardHome, changed)}\n`);
    exitCode = 1;
  }
  if (keep) console.log(`openclaw-github-review tests: kept isolated root ${root}`);
  else {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort — a leaked temp root is preferable to masking a result */
    }
  }
  // Close the log before exiting (process.exit would truncate it), and exit via
  // the code so the guard sees a complete report even when tests failed.
  logStream.end(() => {
    // cli#414: seal the report bun just wrote, success or failure. A run that
    // died before writing one leaves none to seal, and the guard fails closed on
    // the missing report.
    // cli#430: the seal is a write too — re-check the report dir and the report
    // and seal paths (a test ran in between) before sealing.
    try {
      assertReportPaths({ env: process.env, reportDir, paths: [reportXml, reportSeal] });
    } catch (err) {
      if (!(err instanceof IsolationRefusal)) throw err;
      console.error(`openclaw-github-review tests: not sealing the report: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    try {
      if (existsSync(reportXml)) {
        const hash = createHash("sha256").update(readFileSync(reportXml)).digest("hex");
        const expected = `${hash}  ${SUITE}\n`;
        // Never write through whatever sits at the seal path now: remove it (rm
        // unlinks a symlink, never its target) and create the file exclusively.
        rmSync(reportSeal, { force: true });
        writeFileSync(reportSeal, expected, { flag: "wx" });
        if (readFileSync(reportSeal, "utf8") !== expected) {
          throw new Error("seal did not read back as written");
        }
      }
    } catch (err) {
      console.error(`openclaw-github-review tests: could not seal the report: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (!callerReporter && !signal && code === 0 && !existsSync(reportXml)) {
      console.error(`openclaw-github-review tests: bun exited 0 but wrote no report at ${reportXml}; failing the run`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = exitCode;
  });
});
