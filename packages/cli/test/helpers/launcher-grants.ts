/**
 * The launcher's grants that are not under the test sandbox HOME, read from the
 * launcher's own definitions (cli#558). A test sandbox HOME created inside any
 * of them makes the launcher's runtime-options gate refuse before the case
 * under test runs, so every test sandbox base must sit outside all of them.
 *
 * The two callers are the launch-control test and the runtime-launch fixture:
 * one shared list and one shared chooser keep them from drifting apart.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BUN_TEMP_DIR, harnessReadPaths } from "../../src/utils/nono.js";

/** Bun's temp dir and the toolchain/interpreter read roots (cli#350 r4g, cli#341 S1b). */
export const LAUNCHER_FIXED_GRANTS = [BUN_TEMP_DIR, ...harnessReadPaths()];

function realOrResolved(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realOrResolved(parent), basename(abs));
  }
}

/** The launcher grant that covers `path` (equal, or an ancestor directory), or null. */
export function launcherGrantCovering(path: string): string | null {
  const target = realOrResolved(path);
  for (const grant of LAUNCHER_FIXED_GRANTS) {
    const root = realOrResolved(grant);
    if (target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)) return grant;
  }
  return null;
}

function canCreateDirIn(candidate: string): boolean {
  try {
    if (!statSync(candidate).isDirectory()) return false;
    rmSync(mkdtempSync(join(candidate, "lg-probe-")), { recursive: true });
    return true;
  } catch {
    return false;
  }
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
    if (canCreateDirIn(candidate) && launcherGrantCovering(candidate) === null) return realpathSync(candidate);
  }
  const existing = candidates.filter((c) => canCreateDirIn(c));
  if (existing.length === 0) {
    throw new Error(
      `no usable base directory exists or is writable (checked ${candidates.join(", ")}); ` +
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

/**
 * What nono's built-in policy grants on `path`, as "<op> via <granted path>
 * (<source>)", or null when it grants neither read nor write. nono applies its
 * default security groups to every profile, a profile without `extends`
 * included, so `nono why --profile default` answers for the groups any fixture
 * profile inherits. A failed or unparseable query throws: no answer is never
 * read as "not granted".
 */
export function nonoBuiltinGrant(nono: string, path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const op of ["read", "write"]) {
    const args = ["why", "--json", "--profile", "default", "--path", path, "--op", op];
    const r = spawnSync(nono, args, { encoding: "utf-8", env, timeout: 10_000 });
    if (r.error || r.status !== 0) {
      throw new Error(`\`${nono} ${args.join(" ")}\` failed (status ${r.status}): ${r.error?.message ?? r.stderr.trim()}`);
    }
    const answer = JSON.parse(r.stdout) as { status?: unknown; granted_path?: unknown; source?: unknown };
    if (answer.status === "allowed") return `${op} via ${String(answer.granted_path)} (${String(answer.source)})`;
    if (answer.status !== "denied") {
      throw new Error(`\`${nono} ${args.join(" ")}\` returned neither allowed nor denied: ${r.stdout.trim()}`);
    }
  }
  return null;
}

/** The default candidates for a real-nono fixture base, in order of preference. */
export function realNonoHomeBaseCandidates(platform: NodeJS.Platform = process.platform): string[] {
  // /var/tmp is outside nono's Linux groups. On macOS, system_read_macos grants
  // /private, /var, /tmp and /Volumes, so neither /var/tmp nor a /var/folders
  // TMPDIR qualifies there; /Users/Shared is the stock world-writable directory
  // outside every macOS group.
  return ["/var/tmp", tmpdir(), ...(platform === "darwin" ? ["/Users/Shared"] : [])];
}

/**
 * A base for a fixture HOME that REAL nono confines (cli#516): outside every
 * launcher grant, as sandboxHomeBase() requires, AND outside every path nono's
 * own built-in groups grant on this host. Inside one, the fixture tests nothing
 * real: nono refuses to start (the group's grant overlaps its state root
 * HOME/.nono), and the launcher refuses the profile (nono reports read access to
 * the fixture HOME's credential files). Each candidate is checked with real
 * nono, never assumed; when none qualifies this throws, naming each candidate
 * and the grant that rules it out.
 */
export function realNonoHomeBase(
  nono: string,
  candidates: string[] = realNonoHomeBaseCandidates(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rejected: string[] = [];
  for (const candidate of candidates) {
    if (!canCreateDirIn(candidate)) {
      rejected.push(`${candidate}: not a writable directory`);
      continue;
    }
    const grant = launcherGrantCovering(candidate);
    if (grant !== null) {
      rejected.push(`${candidate}: inside the launcher's '${grant}' grant`);
      continue;
    }
    const base = realpathSync(candidate);
    const builtin = nonoBuiltinGrant(nono, join(base, "tps-fixture-probe"), env);
    if (builtin !== null) {
      rejected.push(`${candidate}: nono's built-in policy grants ${builtin}`);
      continue;
    }
    return base;
  }
  throw new Error(
    "a real-nono fixture HOME needs a base outside every launcher grant and every path nono's " +
      `built-in policy grants, and no candidate qualifies — ${rejected.join("; ")}`,
  );
}
