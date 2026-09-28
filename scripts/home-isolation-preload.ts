/**
 * home-isolation-preload.ts — the launch-time isolation PRECONDITION for the
 * monorepo test lanes (cli#430).
 *
 * Loaded by the suite launcher (scripts/test-suite.mjs) through bun's
 * `--preload`, so it runs BEFORE any test module. It ABORTS the run unless
 * `os.homedir()` resolves (realpath, so symlinks count) inside the throwaway
 * root the launcher created and passed as TPS_TEST_ROOT.
 *
 * WHY A WHITELIST, NOT A PATCH. Reassigning `process.env.HOME` inside a test
 * does NOT move `os.homedir()` under bun — bun caches the HOME it read at first
 * call — which is exactly how `~/.tps` leaks happened: a test set
 * `process.env.HOME` to a temp dir and the product code (and the test's own
 * assertions) still used the real home. So the isolation is set at LAUNCH TIME,
 * in the child's environment, before bun boots; this guard then refuses to run
 * at all unless the process actually came up under that root. Nothing to
 * intercept and nothing a product `catch` can swallow.
 *
 * The real-`~/.tps` before/after snapshot (scripts/test-home-guard.mjs, driven
 * by the launcher) is the second half: this guard ensures resolution goes to the
 * temp root; the snapshot catches a leak that hard-codes the real path.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

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
