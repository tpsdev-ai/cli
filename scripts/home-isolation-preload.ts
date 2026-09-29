/**
 * home-isolation-preload.ts — the launch-time isolation PRECONDITION for the
 * monorepo test lanes (cli#430).
 *
 * Loaded by the suite launcher (scripts/test-suite.mjs) through bun's
 * `--preload`, and by the repo-root and per-package bunfig.toml files, so it
 * runs BEFORE any test module. It ABORTS the run unless:
 *   1. TPS_TEST_ROOT is set and resolves to a directory;
 *   2. `os.homedir()` resolves (realpath, so symlinks count) inside that root;
 *   3. the root is not, and does not contain, the account's home from the user
 *      database (os.userInfo().homedir) — whatever HOME says;
 *   4. the root is not, and does not contain, the HOME this process runs under
 *      unless a launcher vouched for it: TPS_TEST_ROOT_TOKEN matches the marker
 *      the launcher wrote in the root it created. A bare `bun test` has no
 *      launcher, and rule 2 puts its HOME inside the root, so a bare run —
 *      including `TPS_TEST_ROOT=$HOME bun test` — is refused.
 * (scripts/test-home-guard.mjs `testRootRefusal` holds rules 3 and 4.)
 *
 * WHY A PRECONDITION, NOT A PATCH. Reassigning `process.env.HOME` inside a test
 * does NOT move `os.homedir()` under bun — bun caches the HOME it read at first
 * call — which is exactly how `~/.tps` leaks happened: a test set
 * `process.env.HOME` to a temp dir and the product code (and the test's own
 * assertions) still used the real home. So the isolation is set at LAUNCH TIME,
 * in the child's environment, before bun boots; this guard then refuses to run
 * at all unless the process actually came up under a launcher-made root.
 *
 * WHAT IT IS NOT. A launch-time check, not an OS boundary: a caller who forges
 * the launcher's marker and token, or code that ignores HOME, can still reach
 * the real home (the OS-enforced boundary is cli#434). The launcher also gives
 * the child an allowlisted environment (scripts/test-home-guard.mjs
 * `isolatedChildEnv`), and its `~/.tps` metadata snapshot is a diagnostic.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { inside, testRootRefusal } from "./test-home-guard.mjs";

const LAUNCHER = "node scripts/test-suite.mjs <suite>  (or `bun run test`)";

function abort(offending: string): never {
  console.error(
    [
      `HOME-ISOLATION GUARD: refusing to run the suite — ${offending}.`,
      "  The cli suite resolves ~/.tps (identity, credentials, auth, agents, run,",
      "  mail, outbox, …) from the process HOME, so a run under the real HOME writes",
      "  into the live tree. Run the suite through its isolated launcher instead:",
      `    ${LAUNCHER}`,
    ].join("\n"),
  );
  process.exit(1);
}

function realpathOrAbort(value: string, label: string): string {
  try {
    return realpathSync(value);
  } catch {
    abort(`${label}="${value}" does not resolve to a directory`);
  }
}

const root = process.env.TPS_TEST_ROOT;
if (!root) {
  abort("TPS_TEST_ROOT is not set, so no isolated test root is known");
}
const rootReal = realpathOrAbort(root, "TPS_TEST_ROOT");

const home = realpathOrAbort(homedir(), "os.homedir()");
if (!inside(rootReal, home)) {
  abort(`os.homedir() resolves to "${home}", which is OUTSIDE the isolated test root "${rootReal}"`);
}

const refusal = testRootRefusal({ rootReal, homeReal: home, token: process.env.TPS_TEST_ROOT_TOKEN });
if (refusal) {
  abort(refusal);
}

// A lane that also isolates the mail dir (the plugin lane) can require it here;
// the monorepo lanes instead rely on the HOME override, so TPS_MAIL_DIR may
// legitimately point at a test-owned temp dir outside TPS_TEST_ROOT.
if (process.env.TPS_TEST_REQUIRE_MAIL_ISOLATION === "1") {
  const mail = process.env.TPS_MAIL_DIR;
  if (!mail) {
    abort("TPS_MAIL_DIR is not set, so the CLI mail/archive dirs are not isolated");
  }
  const mailReal = realpathOrAbort(mail, "TPS_MAIL_DIR");
  if (!inside(rootReal, mailReal)) {
    abort(`TPS_MAIL_DIR resolves to "${mailReal}", which is OUTSIDE the isolated test root "${rootReal}"`);
  }
}
