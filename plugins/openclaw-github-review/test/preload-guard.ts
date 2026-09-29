/**
 * preload-guard.ts — the launch-time isolation precondition for the
 * openclaw-github-review suite.
 *
 * Loaded by bun's `test` preload (bunfig.toml), so it runs BEFORE any test
 * module. It aborts unless os.homedir() resolves inside the throwaway root the
 * launcher created, passed to the child as TPS_TEST_ROOT.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

function abort(offending: string): never {
  console.error(
    [
      `openclaw-github-review ISOLATION GUARD: refusing to run the suite — ${offending}.`,
      "  Run it through the isolated launcher:",
      "    bun run --cwd plugins/openclaw-github-review test",
      "    node plugins/openclaw-github-review/scripts/run-tests.mjs",
    ].join("\n"),
  );
  process.exit(1);
}

const root = process.env.TPS_TEST_ROOT;
if (!root) abort("TPS_TEST_ROOT is not set, so no isolated test root is known");
const rootReal = (() => {
  try {
    return realpathSync(root);
  } catch {
    abort(`TPS_TEST_ROOT="${root}" does not resolve to a directory`);
  }
})();

const home = (() => {
  try {
    return realpathSync(homedir());
  } catch {
    abort("os.homedir() does not resolve to a directory");
  }
})();

const inside = (r: string, p: string) => p === r || p.startsWith(r + sep);
if (!inside(rootReal, home)) {
  abort(`os.homedir() resolves to "${home}", OUTSIDE the isolated root "${rootReal}"`);
}
