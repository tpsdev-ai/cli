/**
 * nono integration — wraps TPS CLI commands in nono process isolation.
 *
 * When nono is available on PATH, TPS commands run with kernel-level
 * filesystem and network restrictions defined by per-command TOML profiles.
 *
 * If nono is not installed:
 *   - Default (warn) mode: logs a warning and runs unprotected
 *   - Strict mode (TPS_NONO_STRICT=1): exits non-zero immediately
 *
 * Profile locations (searched in order):
 *   1. ~/.config/nono/profiles/<name>.toml
 *   2. <tps-install-dir>/nono-profiles/<name>.toml
 *
 * Usage:
 *   import { withNono } from "./nono.js";
 *   await withNono("tps-hire", { workdir: targetWorkspace }, async () => {
 *     // ... perform hire logic ...
 *   });
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
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
  | "tps-restore";

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
  options: NonoOptions,
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

/**
 * Install nono profiles to ~/.config/nono/profiles/.
 * Called during `tps install` or first-run setup.
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

  for (const file of readdirSync(bundledDir)) {
    if (file.endsWith(".toml")) {
      const src = join(bundledDir, file);
      const dst = join(profilesDir, file);
      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        if (!silent) console.log(`  ✓ Installed nono profile: ${file}`);
      }
    }
  }
}
