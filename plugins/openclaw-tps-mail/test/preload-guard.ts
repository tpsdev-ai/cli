/**
 * preload-guard.ts — the launch-time isolation PRECONDITION for the
 * openclaw-tps-mail plugin suite (cli#398 round 2, item 1b; cli#430).
 *
 * Loaded by bun's `test` PRELOAD (bunfig.toml `[test] preload`), so it runs
 * BEFORE any test module is loaded. It ABORTS the run unless:
 *   1. TPS_TEST_ROOT is set and resolves to a directory;
 *   2. `os.homedir()` resolves (realpath, so symlinks count) inside that root;
 *   3. the root is not, and does not contain, the account's home from the user
 *      database (os.userInfo().homedir) — whatever HOME says;
 *   4. the root is not, and does not contain, the HOME this process runs under
 *      unless the launcher (scripts/run-tests.mjs) vouched for it:
 *      TPS_TEST_ROOT_TOKEN matches the marker it wrote in the root it created.
 *      So a bare `bun test` — including one with TPS_TEST_ROOT=$HOME and a
 *      TPS_MAIL_DIR under it — is refused;
 *   5. TPS_MAIL_DIR is set and resolves inside the root.
 * (Rules 3 and 4 are the shared scripts/test-home-guard.mjs `testRootRefusal`;
 * this plugin's tests run only inside the monorepo.)
 *
 * It deliberately does NOT try to intercept writes: an fs patch cannot see
 * `import { writeFileSync } from "node:fs"`, and an in-process
 * `process.env.HOME` reassignment cannot move `os.homedir()`. It is a
 * launch-time check, not an OS boundary: a caller who forges the launcher's
 * marker and token, or code that ignores HOME, can still reach the real home
 * (the OS-enforced boundary is cli#434).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { inside, testRootRefusal } from "../../../scripts/test-home-guard.mjs";

const SCRIPT = "bun run --cwd plugins/openclaw-tps-mail test";
const LAUNCHER = "node plugins/openclaw-tps-mail/scripts/run-tests.mjs";

function abort(offending: string): never {
  console.error(
    [
      `openclaw-tps-mail ISOLATION GUARD: refusing to run the suite — ${offending}.`,
      "  The plugin's outbox/archive writers resolve ~/.tps and the CLI mail dirs from",
      "  the process HOME, so a run under a real HOME writes SIGNED MAIL into the LIVE",
      "  outbox. Run the suite through the isolated launcher instead:",
      `    ${SCRIPT}`,
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

const mail = process.env.TPS_MAIL_DIR;
if (!mail) {
  abort("TPS_MAIL_DIR is not set, so the CLI mail/archive dirs are not isolated");
}
const mailReal = realpathOrAbort(mail, "TPS_MAIL_DIR");
if (!inside(rootReal, mailReal)) {
  abort(`TPS_MAIL_DIR resolves to "${mailReal}", which is OUTSIDE the isolated test root "${rootReal}"`);
}
