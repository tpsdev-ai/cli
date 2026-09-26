#!/usr/bin/env node
/**
 * run-tests.mjs — the isolated launcher for the openclaw-tps-mail plugin suite
 * (cli#398 round 2, item 1).
 *
 * WHY A LAUNCHER. The plugin's writers resolve `~/.tps/...` and the CLI's
 * mail/archive helpers through `process.env.HOME` / `os.homedir()`; with a real
 * HOME a fixture writes a SIGNED MAIL into the LIVE outbox (and archive rows
 * into the live archive.db). Two facts rule out fixing this inside the
 * process: (1) reassigning `process.env.HOME` does not change `os.homedir()`,
 * so anything that captured `homedir()` at module load cannot be redirected
 * that way; (2) patching `fs.writeFileSync` does not intercept code that did
 * `import { writeFileSync } from "node:fs"`. So the isolation must be set at
 * LAUNCH TIME, in the child's environment, before bun boots.
 *
 * WHAT IT DOES. It creates a throwaway root, creates the mail + keys dirs
 * under it, and launches `bun test` with HOME, TPS_MAIL_DIR and
 * TPS_TEST_KEYS_DIR pointing inside that root. Any inherited TPS_MAIL_DIR is
 * UNSET first (so a stale real one cannot leak back in). The root is passed to
 * the child as TPS_TEST_ROOT, which the bun test preload
 * (test/preload-guard.ts) whitelists against — a run that is NOT under this
 * root aborts before any test module loads.
 *
 * USAGE
 *   node scripts/run-tests.mjs [bun test args…]   # default: `test/`
 *   TPS_TEST_KEEP_ROOT=1 node scripts/run-tests.mjs   # keep the temp root,
 *                                                      # printed for inspection
 *
 * cli#411: the run writes a JUnit report (test-reports/plugin.xml, bun
 * --reporter=junit) — the record the coverage guard reads — and the suite's
 * console output beside it (test-reports/plugin.log), both at the repo root, or
 * under TPS_TEST_REPORT_DIR when set. It DELETES its own report and log BEFORE
 * launching, so a file left by an earlier step or run cannot stand in for this
 * run's; and the guard reads the XML only, so a test that prints a path-shaped
 * line cannot put a file into the executed set. The flags are set here rather
 * than imported from the monorepo's scripts/test-suite.mjs so this launcher
 * stays self-contained (it ships inside the plugin's own package), and a
 * caller's own --reporter argument is left alone.
 *
 * cli#414: once bun exits, this launcher SEALS the report it produced —
 * test-reports/plugin.xml.sha256, holding the report's SHA-256 and the suite
 * name "plugin", read back once — so a later suite cannot replace it after the
 * suite ended. The seal format is the one check-test-reports.mjs parses and
 * scripts/test-suite.mjs writes; it is spelled out here because this launcher
 * is self-contained. A stale seal is deleted with the report and log before the
 * run starts.
 * The limit, stated: the seal defeats an ACCIDENTAL overwrite by a later step in
 * the same job; it is not a defence against code in the same job that rewrites
 * the report and the seal together — that code shares the job's filesystem, and
 * the job's credential separation is the control for it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.env.TPS_TEST_KEEP_ROOT === "1";

// realpath the root: on macOS /tmp is a symlink to /private/tmp, and the guard
// compares realpaths so a symlinked tmpdir still counts as "inside".
const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-tps-mail-test-")));
const mailDir = join(root, ".tps", "mail");
const keysDir = join(root, "keys");
mkdirSync(mailDir, { recursive: true });
mkdirSync(keysDir, { recursive: true });

// Child env: UNSET the ambient values first, then set the launch-time ones.
const env = { ...process.env };
delete env.TPS_MAIL_DIR;
delete env.TPS_TEST_KEYS_DIR;
delete env.TPS_TEST_ROOT;
Object.assign(env, {
  HOME: root,
  TPS_MAIL_DIR: mailDir,
  TPS_TEST_KEYS_DIR: keysDir,
  TPS_TEST_ROOT: root,
  // The CLI mail helpers refuse in test mode without an explicit TPS_MAIL_DIR
  // (packages/cli/src/utils/mail.ts); make that requirement explicit here.
  TPS_MAIL_REQUIRE_EXPLICIT_DIR: "1",
});

console.log(`openclaw-tps-mail tests: isolated root ${root}`);

// cli#411: test-reports/<suite>.xml + .log, beside the other suites' reports.
const repoRoot = resolve(pluginDir, "..", "..");
const reportDir = process.env.TPS_TEST_REPORT_DIR
  ? resolve(process.env.TPS_TEST_REPORT_DIR)
  : join(repoRoot, "test-reports");
mkdirSync(reportDir, { recursive: true });
const reportXml = join(reportDir, "plugin.xml");
const reportLog = join(reportDir, "plugin.log");
// cli#414: the seal this run writes when the suite exits, holding the report's
// SHA-256 and the suite name. Written and read back on close.
const reportSeal = join(reportDir, "plugin.xml.sha256");
// Stale artifacts go first: this run's report must be the one the guard reads,
// and this run's seal must vouch for it (not a seal left by an earlier run).
rmSync(reportXml, { force: true });
rmSync(reportLog, { force: true });
rmSync(reportSeal, { force: true });

const passthrough = process.argv.slice(2);
const args = ["test", ...(passthrough.length ? passthrough : ["test/"])];
if (!args.some((arg) => arg.startsWith("--reporter"))) {
  args.push("--reporter=junit", `--reporter-outfile=${reportXml}`);
}
const child = spawn("bun", args, {
  cwd: pluginDir,
  env,
  stdio: ["inherit", "pipe", "pipe"],
});

// Forward the output to this process's streams AND to the suite's log. The log is
// the console record kept for the CI step; the guard reads only the XML.
const logStream = createWriteStream(reportLog, { flags: "w" });
child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});

child.on("error", (err) => {
  console.error(`openclaw-tps-mail tests: could not launch bun: ${err.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (keep) {
    console.log(`openclaw-tps-mail tests: kept isolated root ${root}`);
  } else {
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
    try {
      if (existsSync(reportXml)) {
        const hash = createHash("sha256").update(readFileSync(reportXml)).digest("hex");
        const expected = `${hash}  plugin\n`;
        writeFileSync(reportSeal, expected);
        if (readFileSync(reportSeal, "utf8") !== expected) {
          throw new Error("seal did not read back as written");
        }
      }
    } catch (err) {
      console.error(`openclaw-tps-mail tests: could not seal the report: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = signal ? 1 : (code ?? 1);
  });
});
