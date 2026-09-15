/**
 * nono integration — wraps TPS CLI commands in nono process isolation.
 *
 * When nono is available on PATH, TPS commands run with kernel-level
 * filesystem and network restrictions defined by per-command JSON profiles.
 *
 * If nono is not installed:
 *   - Default (warn) mode: logs a warning and runs unprotected
 *   - Strict mode (TPS_NONO_STRICT=1): exits non-zero immediately
 *
 * Profiles (cli#341 S1b). A profile is JSON (nono 0.70+ shape) with `extends`.
 * A profile that is MISSING or fails `nono profile validate --strict` is a
 * FAILURE — the run stops (EX_CONFIG). There is no warn-and-continue path for
 * an unloadable sandbox.
 *
 * Profile locations (searched in order):
 *   1. ~/.config/nono/profiles/<name>.json
 *   2. <tps-install-dir>/nono-profiles/<name>.json
 *
 * Usage:
 *   import { withNono } from "./nono.js";
 *   await withNono("tps-hire", { workdir: targetWorkspace }, async () => {
 *     // ... perform hire logic ...
 *   });
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type NonoProfile =
  | "tps-hire"
  | "tps-roster"
  | "tps-review-local"
  | "tps-review-deep"
  | "tps-bootstrap"
  | "tps-backup"
  | "tps-restore"
  | "tps-status"
  | "tps-agent-run";

export interface NonoOptions {
  /** Override workdir for the nono sandbox (--workdir flag) */
  workdir?: string;
  /** Extra read-only paths to allow */
  read?: string[];
  /** Extra read-write paths to allow */
  allow?: string[];
}

/**
 * Find the nono binary on PATH. Returns the resolved path or null.
 */
export function findNono(): string | null {
  if (process.env.TPS_FORCE_NO_NONO === "1") return null;
  const result = spawnSync("which", ["nono"], {
    encoding: "utf-8",
    env: process.env, // explicitly pass so PATH mutations in tests are respected
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return null;
}

/**
 * Check if strict mode is enabled (TPS_NONO_STRICT=1).
 * In strict mode, TPS exits if nono is not available.
 */
export function isNonoStrict(): boolean {
  return process.env.TPS_NONO_STRICT === "1";
}

// ---------------------------------------------------------------------------
// Profile loading (cli#341 S1b) — validate-or-FAIL, never warn-and-continue
// ---------------------------------------------------------------------------

/** First nono release with the JSON profile schema and `nono profile`. */
export const NONO_MIN_VERSION = "0.70.0";

/** sysexits.h EX_CONFIG — the configuration (here: the profile) is wrong. */
export const EX_CONFIG = 78;

/**
 * Resolve a profile name to a JSON file on disk, or null.
 * Searches ~/.config/nono/profiles/ then the bundled nono-profiles/ directory.
 */
export function resolveProfilePath(name: string): string | null {
  const home = process.env.HOME || homedir() || "/tmp";
  const candidates = [
    join(home, ".config", "nono", "profiles", `${name}.json`),
    join(findBundledProfilesDir(), `${name}.json`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** `nono --version` → "x.y.z", or null if it cannot be parsed. */
export function nonoVersion(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], { encoding: "utf-8", env: process.env });
  if (result.status !== 0 || !result.stdout) return null;
  const m = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Semver-ish >= for the version floor (no prerelease handling needed). */
export function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split(".").map((n) => Number.parseInt(n, 10));
  const b = min.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i]! : 0;
    const y = Number.isFinite(b[i]) ? b[i]! : 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface ProfileCheck {
  ok: boolean;
  /** Resolved profile path when found. */
  path?: string;
  /** Human-readable reason when not ok. */
  reason?: string;
}

/**
 * Validate-or-FAIL. The profile must exist AND pass `nono profile validate
 * --strict`. Anything else is a refusal: a sandbox that cannot be loaded stops
 * the run. Returns the resolved path on success.
 *
 * `bin` is injectable for tests; pass null to check existence only (used when
 * nono is absent and the caller's nono policy handles that separately).
 */
export function checkProfileLoadable(name: string, bin: string | null = findNono()): ProfileCheck {
  const path = resolveProfilePath(name);
  if (!path) {
    return {
      ok: false,
      reason:
        `profile ${name}.json was not found in ~/.config/nono/profiles/ or the bundled ` +
        `nono-profiles/ directory`,
    };
  }
  if (!bin) return { ok: true, path };

  const version = nonoVersion(bin);
  if (version && !versionAtLeast(version, NONO_MIN_VERSION)) {
    return {
      ok: false,
      path,
      reason: `nono ${version} at ${bin} is below the ${NONO_MIN_VERSION} floor — it predates JSON profiles`,
    };
  }

  const validate = spawnSync(bin, ["profile", "validate", "--strict", path], {
    encoding: "utf-8",
    env: process.env,
  });
  if (validate.status !== 0) {
    const detail = `${validate.stdout ?? ""}${validate.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n");
    return {
      ok: false,
      path,
      reason: `\`nono profile validate --strict ${path}\` exited ${validate.status}:\n${detail}`,
    };
  }
  return { ok: true, path };
}

/**
 * System read roots. Replaces the old blanket `--read /`: a root grant is
 * refused by nono 0.70+, so the harness grants the toolchain roots explicitly.
 * Kern validated the macOS set; the Linux set is its equivalent.
 */
export function systemReadPaths(): string[] {
  return process.platform === "darwin"
    ? ["/opt/homebrew", "/usr", "/bin", "/sbin", "/Library"]
    : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
}

/**
 * Read grants every TPS harness family needs: the agent identity dir, the bun
 * cache, the running interpreter's own directory, plus the system roots. One
 * definition so `agent start` and `mail watch` cannot drift apart (cli#341 S1b).
 */
export function harnessReadPaths(): string[] {
  return [
    join(homedir(), ".tps", "identity"),
    join(homedir(), ".bun"),
    dirname(process.execPath),
    ...systemReadPaths(),
  ];
}

/**
 * Build the nono command args for a given profile and subcommand.
 *
 * Returns: ["nono", "run", "--profile", name, ...options, "--", ...cmd]
 */
export function buildNonoArgs(
  profile: NonoProfile,
  options: NonoOptions,
  cmd: string[]
): string[] {
  const args = ["run", "--profile", profile, "--allow-cwd"];

  if (options.workdir) {
    args.push("--workdir", options.workdir);
  }

  for (const p of options.read ?? []) {
    args.push("--read", p);
  }

  for (const p of options.allow ?? []) {
    args.push("--allow", p);
  }

  args.push("--", ...cmd);
  return args;
}

/**
 * Run a function wrapped in nono isolation.
 *
 * If nono is unavailable:
 *   - strict mode → throws (exits non-zero)
 *   - warn mode (default) → logs warning and runs fn directly
 *
 * The callback receives the nono binary path (or null if unavailable).
 * In most cases you won't need it — this wrapper handles invocation.
 *
 * Note: This wrapper is for use when TPS itself is the process being
 * sandboxed. The more common case is calling `runUnderNono()` to spawn
 * a subprocess under nono.
 */
export async function withNono(
  profile: NonoProfile,
  _options: NonoOptions,
  fn: () => Promise<void>
): Promise<void> {
  const nono = findNono();

  if (!nono) {
    if (isNonoStrict()) {
      console.error(
        `❌ nono is not installed but TPS_NONO_STRICT=1. Install nono from https://nono.sh`
      );
      process.exit(1);
    } else {
      console.warn(
        `⚠️  nono not found — running ${profile} WITHOUT isolation. Install nono for security: https://nono.sh`
      );
      return fn();
    }
  }

  // nono is available — but only proceed if the profile can actually load.
  // Validate-or-FAIL: an unloadable sandbox stops the run (cli#341 S1b).
  const check = checkProfileLoadable(profile, nono);
  if (!check.ok) {
    console.error(
      `❌ nono profile failed to load — refusing to run outside the sandbox (cli#341):\n` +
        `   profile: ${profile}\n   reason:  ${check.reason}`
    );
    process.exit(EX_CONFIG);
  }

  // nono is available — run the callback directly (the current process IS already
  // being run via nono by the calling shell, or we re-exec under nono).
  // For TPS's architecture, we use runCommandUnderNono() for subprocess isolation.
  return fn();
}

/**
 * Spawn an external command under nono isolation.
 *
 * Returns the exit code of the wrapped command.
 * Throws if nono is unavailable and strict mode is on.
 */
export function runCommandUnderNono(
  profile: NonoProfile,
  options: NonoOptions,
  cmd: string[]
): number {
  const nono = findNono();

  if (!nono) {
    if (isNonoStrict()) {
      console.error(
        `❌ nono is not installed but TPS_NONO_STRICT=1. Install nono from https://nono.sh`
      );
      return 1;
    }
    console.warn(
      `⚠️  nono not found — running WITHOUT isolation: ${cmd.join(" ")}`
    );
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      stdio: "inherit",
      encoding: "utf-8",
      env: process.env,
    });
    return result.status ?? 1;
  }

  // Validate-or-FAIL before we depend on the profile (cli#341 S1b): a missing
  // or invalid profile is a refusal, never a warn-and-continue.
  const check = checkProfileLoadable(profile, nono);
  if (!check.ok) {
    console.error(
      `❌ nono profile failed to load — refusing to run without isolation (cli#341):\n` +
        `   profile: ${profile}\n   reason:  ${check.reason}`
    );
    return EX_CONFIG;
  }

  const args = buildNonoArgs(profile, options, cmd);
  const result = spawnSync(nono, args, {
    stdio: "inherit",
    encoding: "utf-8",
    env: process.env,
  });
  return result.status ?? 1;
}

function findBundledProfilesDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "nono-profiles"),          // dist/src/utils -> nono-profiles
    join(__dirname, "..", "..", "..", "nono-profiles"),     // deeper nesting
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(__dirname, "..", "..", "nono-profiles"); // fallback
}

/** sha256 of a file's bytes — the content hash installNonoProfiles compares. */
function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Install the bundled nono profiles into `~/.config/nono/profiles/`
 * (or `targetDir`). Called during `tps install` / first-run setup.
 *
 * MIGRATION (cli#341 S1b, spec v1/v2 — the window-closer):
 *   - Overwrite an installed TPS profile whenever the bundled content differs
 *     (content-hash versioned). nono resolves `extends` BY NAME across locations
 *     (~/.config first), so a stale `~/.config/.../tps-base.json` SHADOWS the
 *     bundled deny list for every child everywhere — a changed deny list MUST
 *     propagate, not be masked by an if-not-exists copy.
 *   - Retire a stale TPS-named `*.toml` profile (the pre-2.0 dialect).
 *   - Never touch user-authored NON-TPS profiles: everything is keyed on the set
 *     of names we ship, not a blanket glob of the directory.
 *   - validate-or-FAIL when nono supports JSON profiles: an unloadable profile
 *     is never installed silently.
 */
export function installNonoProfiles(targetDir?: string, silent?: boolean): void {
  const home = process.env.HOME || homedir() || "/tmp";
  const profilesDir = targetDir ?? join(home, ".config", "nono", "profiles");

  // Source: bundled profiles shipped with TPS
  const bundledDir = findBundledProfilesDir();

  if (!existsSync(bundledDir)) {
    if (!silent) console.warn(`⚠️  No bundled nono profiles found at ${bundledDir}`);
    return;
  }

  mkdirSync(profilesDir, { recursive: true });

  const bundled = readdirSync(bundledDir).filter((f) => f.endsWith(".json"));
  const shippedNames = new Set(bundled.map((f) => f.replace(/\.json$/, "")));

  // (b) Retire stale TPS-named *.toml (only names we ship — user files stay).
  for (const entry of readdirSync(profilesDir)) {
    if (!entry.endsWith(".toml")) continue;
    if (!shippedNames.has(entry.replace(/\.toml$/, ""))) continue;
    unlinkSync(join(profilesDir, entry));
    if (!silent) console.log(`  ✓ Retired stale nono profile: ${entry}`);
  }

  const bin = findNono();
  // Validate only when nono is new enough to have JSON profiles at all. An
  // absent/too-old nono cannot load them either way; the *launch* path
  // (checkProfileLoadable) is where an unsupported nono is refused.
  const version = bin ? nonoVersion(bin) : null;
  const canValidate = Boolean(bin && version && versionAtLeast(version, NONO_MIN_VERSION));
  for (const file of bundled) {
    const src = join(bundledDir, file);
    const dst = join(profilesDir, file);
    // (a) Overwrite whenever the content differs (content-hash versioned).
    const present = existsSync(dst);
    if (!present || fileSha256(src) !== fileSha256(dst)) {
      copyFileSync(src, dst);
      if (!silent) console.log(`  ✓ ${present ? "Updated" : "Installed"} nono profile: ${file}`);
    }
    if (canValidate) {
      const name = file.replace(/\.json$/, "");
      const check = checkProfileLoadable(name, bin);
      if (!check.ok) {
        console.error(
          `❌ installed nono profile fails validation — refusing to continue (cli#341):\n` +
            `   profile: ${dst}\n   reason:  ${check.reason}`
        );
        process.exit(EX_CONFIG);
      }
    }
  }
}
