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
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** The fixed half of the line the probe prints when the sandboxed read fails. */
export const NONO_PROBE_DENIED_PREFIX = "TPS-NONO-PROBE-DENIED-";

/** What real nono did with a sandboxed read of a file under a candidate base. */
export type NonoProbeVerdict =
  | { kind: "denied" }
  | { kind: "granted" }
  | { kind: "refused"; stderr: string };

/**
 * Measure, with real nono, whether its built-in policy lets a sandboxed process
 * read a file under `base` (cli#516). A scratch directory under `base` holds a
 * fixture-like HOME and a file with a random nonce; nono runs
 * `sh -c 'cat <file> || echo <marker>'` under a profile that only extends
 * nono's `default`. Behavioural on purpose: it needs nothing from nono beyond
 * `run`, the invocation every real-nono case already depends on (the pinned
 * Linux build answered `nono why --profile default` with exit 0 and no output).
 *
 *   - the marker, exit 0: nono ran and the read was denied — "denied";
 *   - the nonce, exit 0: the default policy grants read there — "granted";
 *   - non-zero with no output: nono refused to start — "refused", with its
 *     stderr (on macOS, a default group's grant overlapping the state root
 *     HOME/.nono is refused this way);
 *   - anything else throws: an unknown answer is never "not granted".
 *
 * Neither the nonce nor the whole marker appears in nono's argv, so nono
 * echoing its command line cannot pass for either answer.
 */
export function probeNonoBuiltinRead(
  nono: string,
  base: string,
  env: NodeJS.ProcessEnv = process.env,
): NonoProbeVerdict {
  const scratch = mkdtempSync(join(base, "tps-nono-probe-"));
  try {
    const home = join(scratch, "home");
    const profileDir = join(home, ".config", "nono", "profiles");
    const cwd = join(scratch, "cwd");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(cwd);
    const profile = join(profileDir, "tps-nono-probe.json");
    writeFileSync(
      profile,
      JSON.stringify({
        $schema: "https://nono.sh/schemas/nono-profile.schema.json",
        extends: "default",
        meta: { name: "tps-nono-probe" },
      }),
    );
    const file = join(scratch, "probe-file");
    const nonce = `tps-nono-probe-nonce-${randomBytes(8).toString("hex")}`;
    writeFileSync(file, `${nonce}\n`);
    const token = randomBytes(8).toString("hex");
    const marker = `${NONO_PROBE_DENIED_PREFIX}${token}`;
    const args = [
      "run", "-s", "--profile", profile, "--",
      "sh", "-c", `cat "$1" || echo "${NONO_PROBE_DENIED_PREFIX}$2"`, "sh", file, token,
    ];
    const r = spawnSync(nono, args, {
      cwd,
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...env, HOME: home, XDG_STATE_HOME: join(scratch, "nono-state") },
    });
    const stdout = (r.stdout ?? "").trim();
    const stderr = (r.stderr ?? "").trim();
    if (!r.error && r.status === 0 && stdout === marker) return { kind: "denied" };
    if (!r.error && r.status === 0 && stdout === nonce) return { kind: "granted" };
    if (!r.error && typeof r.status === "number" && r.status !== 0 && stdout === "") {
      return { kind: "refused", stderr };
    }
    throw new Error(
      `the nono read probe under ${base} gave an unknown answer, which is never read as "not granted": ` +
        `\`${nono} ${args.join(" ")}\` ` +
        (r.error ? `failed to run (${r.error.message})` : `exited ${r.status ?? `on signal ${r.signal}`}`) +
        `, stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
 * own built-in policy grants on this host. Inside one, the fixture tests nothing
 * real: nono refuses to start (the grant overlaps its state root HOME/.nono),
 * or the launcher refuses the profile (nono reports read access to the fixture
 * HOME's credential files). Each candidate is measured with real nono
 * (probeNonoBuiltinRead), never assumed; when none qualifies this throws,
 * naming each candidate and what ruled it out. An unknown probe answer throws
 * at once rather than moving on to the next candidate.
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
    const verdict = probeNonoBuiltinRead(nono, base, env);
    if (verdict.kind === "denied") return base;
    rejected.push(
      verdict.kind === "granted"
        ? `${candidate}: nono's default policy lets a sandboxed process read a file under it`
        : `${candidate}: nono refused to start with a fixture HOME under it: ${verdict.stderr || "(no stderr)"}`,
    );
  }
  throw new Error(
    "a real-nono fixture HOME needs a base outside every launcher grant and every path nono's " +
      `built-in policy grants, and no candidate qualifies — ${rejected.join("; ")}`,
  );
}
