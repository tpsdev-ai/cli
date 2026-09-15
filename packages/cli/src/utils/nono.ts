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
 * Launch-path control (cli#341 S1a) — fail-closed, no env escape hatch:
 *   - The old `TPS_FORCE_NO_NONO` environment bypass is GONE. No environment
 *     variable can make the launcher forget that nono exists.
 *   - `--no-sandbox` (the only human escape hatch) is honoured ONLY from an
 *     interactive TTY (stdin AND stdout). Anywhere else it is refused.
 *   - A non-interactive invocation that launches an agent MUST carry
 *     `--sandbox-required`; a launcher that dropped it is refused rather than
 *     silently running unsandboxed. See `evaluateLaunchControl`.
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

import { spawnSync } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Launch-path sandbox control (cli#341 S1a)
// ---------------------------------------------------------------------------
//
// This is the control that decides whether a *launcher* is allowed to start an
// agent, and under what isolation. It is deliberately small and dependency-free
// so it can be unit tested with injected TTY/supervisor state.

/** Asserted by every generated unit that launches an agent. */
export const SANDBOX_REQUIRED_FLAG = "--sandbox-required";

/** The only human escape hatch. Interactive TTY only. */
export const NO_SANDBOX_FLAG = "--no-sandbox";

/**
 * Set by generated units (launchd/systemd) in their environment. A refusal then
 * exits 0 instead of 78 — see the KeepAlive coupling note below.
 */
export const SUPERVISED_ENV = "TPS_SUPERVISED";

/** Exit code for a refusal when NOT running under a supervisor (sysexits: EX_CONFIG). */
export const REFUSAL_EXIT_CODE = 78;

/**
 * KeepAlive coupling (measured, Sherlock):
 *   - `{Crashed:true}` restarts only on *signal* death — `exit 78` gives 1 launch.
 *   - `{SuccessfulExit:false}` + `exit 78` gives 13 relaunches in 12 s.
 * Generated agent units therefore pair `{SuccessfulExit:false}` with "the
 * launcher logs the refusal and exits 0" (`${SUPERVISED_ENV}=1`). A refusal is a
 * clean exit 0 → no relaunch storm; a genuine crash is non-zero/signal → relaunch.
 */
export const SUPERVISED_REFUSAL_EXIT_CODE = 0;

/** `--quiet-nono-check` (renamed from `--nonono`): only skips the loud check. */
export const QUIET_NONO_CHECK_FLAG = "--quiet-nono-check";
/** Deprecated hidden alias, kept for one release. */
export const LEGACY_NONONO_FLAG = "--nonono";

export function isInteractiveTty(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout
): boolean {
  // Both ends must be a terminal: a piped stdin with a TTY stdout (or vice
  // versa) is scripted, not a human at the keyboard.
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISED_ENV] === "1";
}

/**
 * Commands that hand control to an agent. These are exactly the commands that
 * generated units invoke, and the ones that must assert `--sandbox-required`
 * when there is no TTY to ask.
 */
export function launchesAgent(command: string | undefined, rest: readonly string[] = []): boolean {
  const sub = rest[0];
  if (command === "agent") return sub === "start";
  if (command === "mail") return sub === "watch";
  if (command === "office") return sub === "connect";
  return false;
}

export interface LaunchControlInput {
  /** Top-level command word (argv[2]). */
  command?: string;
  /** Remaining words after the command. */
  rest?: readonly string[];
  /** Full argv (defaults to process.argv). */
  argv?: readonly string[];
  /** Override TTY detection (tests). */
  interactiveTty?: boolean;
  /** Override supervisor detection (tests). */
  supervised?: boolean;
}

export interface LaunchControlResult {
  allowed: boolean;
  /** Human-readable refusal naming the flag and the reason. */
  refusal?: string;
  /** Process exit code to use for the refusal (0 when supervised). */
  refusalExitCode: number;
}

/**
 * Pure decision function for the launch-path control. Never touches the
 * process; the caller applies the result.
 */
export function evaluateLaunchControl(input: LaunchControlInput = {}): LaunchControlResult {
  const argv = input.argv ?? process.argv;
  const tty = input.interactiveTty ?? isInteractiveTty();
  const supervised = input.supervised ?? isSupervised();
  const refusalExitCode = supervised ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE;
  const deny = (refusal: string): LaunchControlResult => ({ allowed: false, refusal, refusalExitCode });

  // (1) --no-sandbox is honoured only from an interactive TTY.
  if (argv.includes(NO_SANDBOX_FLAG) && !tty) {
    return deny(
      `${NO_SANDBOX_FLAG} is refused: it is only honoured from an interactive TTY ` +
        "(stdin AND stdout must both be terminals). This invocation is not interactive, " +
        "so the agent must launch under nono. Remove the flag, or run it yourself in a terminal.",
    );
  }

  // (2) Non-interactive agent launch must assert --sandbox-required.
  if (launchesAgent(input.command, input.rest) && !tty && !argv.includes(SANDBOX_REQUIRED_FLAG)) {
    const sub = input.rest?.[0] ?? "";
    return deny(
      `${SANDBOX_REQUIRED_FLAG} is required: this non-interactive context is launching an agent ` +
        `(\`${input.command} ${sub}\`) and the launcher did not assert it. A hand-edited plist, ` +
        `a stale wrapper or a dropped argument would otherwise run the agent unsandboxed. ` +
        `Refusing to launch.`,
    );
  }

  return { allowed: true, refusalExitCode: 0 };
}

/**
 * Apply `evaluateLaunchControl` to the current process: log and exit on refusal.
 * Safe to call unconditionally at the top of the launcher.
 */
export function enforceLaunchControl(input: LaunchControlInput = {}): void {
  const result = evaluateLaunchControl(input);
  if (result.allowed || !result.refusal) return;
  console.error(`❌ ${result.refusal}`);
  process.exit(result.refusalExitCode);
}
