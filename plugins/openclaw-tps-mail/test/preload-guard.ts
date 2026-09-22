/**
 * preload-guard.ts — the launch-time isolation PRECONDITION for the
 * openclaw-tps-mail plugin suite (cli#398 round 2, item 1b).
 *
 * Loaded by bun's `test` PRELOAD (bunfig.toml `[test] preload`), so it runs
 * BEFORE any test module is loaded. It ABORTS the run unless BOTH
 * `os.homedir()` AND `TPS_MAIL_DIR` resolve (realpath, so symlinks count)
 * inside the throwaway root the launcher created (scripts/run-tests.mjs),
 * which is passed to the child as TPS_TEST_ROOT.
 *
 * This is a WHITELIST, not a blacklist, and it deliberately does NOT try to
 * intercept writes: an fs patch cannot see `import { writeFileSync } from
 * "node:fs"`, and an in-process `process.env.HOME` reassignment cannot move
 * `os.homedir()`. Instead it refuses to run at all unless the two environment
 * roots the suite depends on are the isolated ones — nothing to intercept,
 * nothing a product `catch` can swallow.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

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

const inside = (rootReal: string, p: string): boolean => p === rootReal || p.startsWith(rootReal + sep);

const root = process.env.TPS_TEST_ROOT;
if (!root) {
  abort("TPS_TEST_ROOT is not set, so no isolated test root is known");
}
const rootReal = realpathOrAbort(root, "TPS_TEST_ROOT");

const home = realpathOrAbort(homedir(), "os.homedir()");
if (!inside(rootReal, home)) {
  abort(`os.homedir() resolves to "${home}", which is OUTSIDE the isolated test root "${rootReal}"`);
}

const mail = process.env.TPS_MAIL_DIR;
if (!mail) {
  abort("TPS_MAIL_DIR is not set, so the CLI mail/archive dirs are not isolated");
}
const mailReal = realpathOrAbort(mail, "TPS_MAIL_DIR");
if (!inside(rootReal, mailReal)) {
  abort(`TPS_MAIL_DIR resolves to "${mailReal}", which is OUTSIDE the isolated test root "${rootReal}"`);
}
