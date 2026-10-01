/**
 * preload-guard.ts — the launch-time isolation precondition for the
 * openclaw-github-review suite (cli#438).
 *
 * Loaded by bun's `test` preload (bunfig.toml), so it runs BEFORE any test
 * module. It ABORTS the run unless:
 *   1. TPS_TEST_ROOT is set and resolves to a directory;
 *   2. `os.homedir()` resolves (realpath, so symlinks count) inside that root;
 *   3. the root is not, and does not contain, the account's home from the user
 *      database (os.userInfo().homedir) — whatever HOME says;
 *   4. the root is not, and does not contain, the HOME this process runs
 *      under, unless the root has a marker matching TPS_TEST_ROOT_TOKEN (the
 *      launcher, scripts/run-tests.mjs, writes one in the root it creates).
 *      So a bare `bun test` — including one with TPS_TEST_ROOT=$HOME — is
 *      refused.
 * (Rules 3 and 4 are the shared `testRootRefusal` from the monorepo's
 * scripts/test-home-guard.mjs.)
 *
 * WHAT IT IS NOT. A launch-time check, not an OS boundary: a caller who forges
 * the marker and token, or code that ignores HOME, can still reach an operator
 * home (the OS-enforced boundary is cli#434).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { inside, testRootRefusal } from "../../../scripts/test-home-guard.mjs";

const LAUNCHER = "node plugins/openclaw-github-review/scripts/run-tests.mjs";

function abort(offending: string): never {
  console.error(
    [
      `openclaw-github-review ISOLATION GUARD: refusing to run the suite — ${offending}.`,
      "  Run it through the isolated launcher:",
      "    bun run --cwd plugins/openclaw-github-review test",
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
