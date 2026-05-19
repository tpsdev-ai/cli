/**
 * facts-verify.ts — Facts Substrate S1: Verify execution (security-critical)
 * (ops-568p child)
 *
 * Runs a manifest-declared verify command with hardened spawn settings.
 * Module contract (Kern): receives ManifestEntry as argument; does NOT load
 * manifest itself; does NOT mutate cache. Cache update happens in the
 * command handler. Drift detection (comparing live to cached) also happens
 * in the command handler, not in runVerify.
 *
 * Security rules (Sherlock):
 * - Restricted PATH { PATH: "/usr/bin:/bin", HOME: os.homedir(), LANG: "C" }
 * - No shell. spawn({ shell: false }) only. Blocklisted commands rejected.
 * - Timeout enforced (default 10000ms, [100, 60000]).
 * - Stdout/stderr bounded at 64KB; truncated flag on overflow.
 * - Control characters stripped from stdout before type coercion.
 * - Explicit cwd: os.homedir().
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { SHELL_BLOCKLIST, type ManifestEntry, type FactType } from "./facts-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifySuccess = {
  ok: true;
  value: string | number | boolean | object;
  raw_stdout: string;
  durationMs: number;
  truncated?: boolean;
};

export type VerifyFailure = {
  ok: false;
  reason: "timeout" | "nonzero_exit" | "invalid_type" | "blocked_command" | "spawn_error";
  detail: string;
  durationMs: number;
  truncated?: boolean;
};

export type VerifyResult = VerifySuccess | VerifyFailure;

export interface SpawnDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STDOUT_BYTES = 64 * 1024; // 64KB
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Restricted child process environment.
 * Only /usr/bin:/bin in PATH. HOME and LANG only.
 */
export function verifyEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    LANG: "C",
  };
}

// ---------------------------------------------------------------------------
// Control character stripping
// ---------------------------------------------------------------------------

/**
 * Strip control characters (0x00-0x1F) from a string, preserving
 * tab (0x09), LF (0x0A), and CR (0x0D).
 *
 * Applied to verify stdout before storage/display. (Sherlock §A)
 */
export function stripControlChars(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — strip terminal control chars from verify stdout (Sherlock §B Appendix item: terminal escape injection)
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

/**
 * Coerce verify stdout to the declared fact type.
 * Returns the coerced value or null if coercion fails.
 */
function coerceValue(raw: string, type: FactType): string | number | boolean | object | null {
  const trimmed = raw.trim();

  switch (type) {
    case "string": {
      if (trimmed.length === 0) return null;
      return trimmed;
    }
    case "int": {
      const parsed = parseInt(trimmed, 10);
      if (Number.isNaN(parsed) || String(parsed) !== trimmed) return null;
      return parsed;
    }
    case "bool": {
      const lower = trimmed.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return true;
      if (lower === "false" || lower === "0" || lower === "no") return false;
      return null;
    }
    case "json": {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Spawn descriptor (preview mode)
// ---------------------------------------------------------------------------

/**
 * Build the spawn descriptor for a fact without executing it.
 * Used by --verify-preview.
 */
export function buildSpawnDescriptor(entry: ManifestEntry): SpawnDescriptor {
  return {
    command: entry.verify.command,
    args: entry.verify.args,
    env: verifyEnv(),
    cwd: homedir(),
    timeout_ms: entry.verify.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// runVerify
// ---------------------------------------------------------------------------

/**
 * Execute the verify command for a fact.
 *
 * Security: validates command against blocklist at exec time (defense in depth),
 * uses restricted PATH, spawn with shell:false, explicit cwd.
 *
 * Contract: receives ManifestEntry as argument; does NOT load manifest or
 * mutate cache. Drift detection is the command handler's responsibility.
 *
 * @param entry - The manifest entry for the fact to verify.
 * @param opts.previewOnly - If true, return the spawn descriptor without executing.
 */
export async function runVerify(
  entry: ManifestEntry,
  opts: { previewOnly?: boolean } = {}
): Promise<VerifyResult> {
  const command = entry.verify.command;
  const args = entry.verify.args;
  const timeoutMs = entry.verify.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();

  // Defense in depth: re-validate command at exec time
  if (SHELL_BLOCKLIST.has(command)) {
    return {
      ok: false,
      reason: "blocked_command",
      detail: `"${command}" is a blocklisted shell. Use absolute paths for non-core binaries.`,
      durationMs: Date.now() - startTime,
    };
  }

  // Preview mode: return descriptor without executing
  if (opts.previewOnly) {
    // Return a successful result with the descriptor as the value
    // (the command handler will format this appropriately)
    return {
      ok: true,
      value: JSON.stringify(buildSpawnDescriptor(entry), null, 2),
      raw_stdout: "",
      durationMs: 0,
    };
  }

  return new Promise<VerifyResult>((resolve) => {
    let stdout = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: homedir(),
      env: verifyEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGKILL after 1s grace period
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length >= MAX_STDOUT_BYTES) return;
      stdout += data.toString("utf-8");
      if (stdout.length >= MAX_STDOUT_BYTES) {
        stdout = stdout.slice(0, MAX_STDOUT_BYTES);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      resolve({
        ok: false,
        reason: "spawn_error",
        detail: err.message,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);

      if (timedOut) {
        resolve({
          ok: false,
          reason: "timeout",
          detail: `timed out after ${timeoutMs}ms`,
          durationMs: timeoutMs,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          reason: "nonzero_exit",
          detail: `exit code ${code}${signal ? ` (signal ${signal})` : ""}`,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // Strip control characters before type coercion
      const cleaned = stripControlChars(stdout);
      const type = entry.type;
      const value = coerceValue(cleaned, type);

      if (value === null) {
        resolve({
          ok: false,
          reason: "invalid_type",
          detail: `stdout "${cleaned.slice(0, 80)}${cleaned.length > 80 ? "..." : ""}" could not be coerced to type "${type}"`,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      const result: VerifySuccess = {
        ok: true,
        value,
        raw_stdout: cleaned,
        durationMs: Date.now() - startTime,
      };

      // Flag if stdout was truncated
      if (stdout.length >= MAX_STDOUT_BYTES || cleaned.length >= MAX_STDOUT_BYTES) {
        result.truncated = true;
      }

      resolve(result);
    });
  });
}
