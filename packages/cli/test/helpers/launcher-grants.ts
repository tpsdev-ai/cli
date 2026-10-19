/** Fixture bases checked against the fixed launcher grants. */
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

/** The fixed launcher grant that covers `path` (equal, or an ancestor directory), or null. */
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

/** A writable fixture base outside the fixed launcher grants. */
export function sandboxHomeBase(candidates: string[] = ["/var/tmp", tmpdir()]): string {
  for (const candidate of candidates) {
    if (canCreateDirIn(candidate) && launcherGrantCovering(candidate) === null) return realpathSync(candidate);
  }
  const existing = candidates.filter((c) => canCreateDirIn(c));
  if (existing.length === 0) {
    throw new Error(
      `no usable base directory exists or is writable (checked ${candidates.join(", ")}); ` +
        "a test sandbox HOME needs a base outside every fixed launcher grant.",
    );
  }
  const grant = launcherGrantCovering(existing[0]);
  const suggestion = existing.includes("/var/tmp") ? "" : " (for example /var/tmp)";
  throw new Error(
    `a test sandbox HOME needs a base outside every fixed launcher grant, but '${existing[0]}' ` +
      `(TMPDIR=${tmpdir()}) falls inside the fixed launcher '${grant}' grant — point TMPDIR at a ` +
      `directory outside it${suggestion} and re-run.`,
  );
}

/** The prefix emitted after an unsuccessful sandboxed read. */
export const NONO_PROBE_DENIED_PREFIX = "TPS-NONO-PROBE-DENIED-";

/** What real nono did with a sandboxed read of a file under a candidate base. */
export type NonoProbeVerdict =
  | { kind: "denied" }
  | { kind: "granted" }
  | { kind: "refused"; stderr: string };

/** Accept a candidate only after an unsandboxed nonce read succeeds and the sandboxed read reports a permission error. */
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
    const probeEnv = { ...env, HOME: home, XDG_STATE_HOME: join(scratch, "nono-state"), LC_ALL: "C" };
    const baseline = spawnSync("cat", [file], { cwd, encoding: "utf-8", timeout: 20_000, env: probeEnv });
    if (baseline.error || baseline.status !== 0 || baseline.stdout.trim() !== nonce) {
      throw new Error(`the unsandboxed read probe failed: ${baseline.error?.message ?? baseline.stderr}`);
    }
    const args = [
      "run", "-s", "--profile", profile, "--",
      "sh", "-c", `if cat "$1"; then exit 0; else status=$?; printf "${NONO_PROBE_DENIED_PREFIX}%s\\n" "$2"; exit "$status"; fi`, "sh", file, token,
    ];
    const r = spawnSync(nono, args, {
      cwd,
      encoding: "utf-8",
      timeout: 20_000,
      env: probeEnv,
    });
    const stdout = (r.stdout ?? "").trim();
    const stderr = (r.stderr ?? "").trim();
    const permissionDenied = stderr.split("\n").some((line) =>
      line === `cat: ${file}: Permission denied` || line === `cat: ${file}: Operation not permitted`);
    if (!r.error && r.status === 1 && stdout === marker && permissionDenied) return { kind: "denied" };
    if (stdout === marker) throw new Error(`the sandboxed read probe failed: exit ${r.status}, stderr ${JSON.stringify(stderr)}`);
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
  return ["/var/tmp", tmpdir(), ...(platform === "darwin" ? ["/Users/Shared"] : [])];
}

/** A writable base outside the fixed launcher grants where the nono read probe is denied. */
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
      rejected.push(`${candidate}: inside the fixed launcher '${grant}' grant`);
      continue;
    }
    const base = realpathSync(candidate);
    const verdict = probeNonoBuiltinRead(nono, base, env);
    if (verdict.kind === "denied") return base;
    rejected.push(
      verdict.kind === "granted"
        ? `${candidate}: nono's default policy lets a sandboxed process read a file under it`
        : `${candidate}: the probe produced no output and exited nonzero: ${verdict.stderr || "(no stderr)"}`,
    );
  }
  throw new Error(
    "a real-nono fixture HOME needs a base outside every fixed launcher grant where nono's " +
      `built-in policy denies a scratch file under it, and no candidate qualifies — ${rejected.join("; ")}`,
  );
}
