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
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const passthrough = process.argv.slice(2);
const child = spawn("bun", ["test", ...(passthrough.length ? passthrough : ["test/"])], {
  cwd: pluginDir,
  env,
  stdio: "inherit",
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
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
