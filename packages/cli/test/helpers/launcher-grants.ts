/**
 * The launcher's grants that are not under the test sandbox HOME, read from the
 * launcher's own definitions (cli#558). A test sandbox HOME created inside any
 * of them makes the launcher's runtime-options gate refuse before the case
 * under test runs, so every test sandbox base must sit outside all of them.
 *
 * The two callers are the launch-control test and the runtime-launch fixture:
 * one shared list and one shared chooser keep them from drifting apart.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BUN_TEMP_DIR, harnessReadPaths } from "../../src/utils/nono.js";

/** Bun's temp dir and the toolchain/interpreter read roots (cli#350 r4g, cli#341 S1b). */
export const LAUNCHER_FIXED_GRANTS = [BUN_TEMP_DIR, ...harnessReadPaths()];

/** The launcher grant that covers `path` (equal, or an ancestor directory), or null. */
export function launcherGrantCovering(path: string): string | null {
  const target = resolve(path);
  for (const grant of LAUNCHER_FIXED_GRANTS) {
    const root = resolve(grant);
    if (target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)) return grant;
  }
  return null;
}

/**
 * A base directory for a test sandbox HOME that lies outside every launcher
 * grant (cli#558). `/var/tmp` is the sibling of the always-granted `/tmp` and
 * sits outside it; the process temp dir is the fallback. If a TMPDIR leaves
 * neither candidate outside the grants, refuse up front, naming TMPDIR and the
 * grant tmpdir() falls inside, rather than let the launcher's gate report a
 * misleading early refusal.
 */
export function sandboxHomeBase(candidates: string[] = ["/var/tmp", tmpdir()]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate) && launcherGrantCovering(candidate) === null) return candidate;
  }
  const existing = candidates.filter((c) => existsSync(c));
  if (existing.length === 0) {
    throw new Error(
      `no usable base directory exists (checked ${candidates.join(", ")}); ` +
        "a test sandbox HOME needs a base outside every launcher grant.",
    );
  }
  const grant = launcherGrantCovering(existing[0]);
  const suggestion = existing.includes("/var/tmp") ? "" : " (for example /var/tmp)";
  throw new Error(
    `a test sandbox HOME needs a base outside every launcher grant, but '${existing[0]}' ` +
      `(TMPDIR=${tmpdir()}) falls inside the launcher's '${grant}' grant — point TMPDIR at a ` +
      `directory outside it${suggestion} and re-run.`,
  );
}
