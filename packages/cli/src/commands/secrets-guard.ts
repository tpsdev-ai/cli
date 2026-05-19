/**
 * secrets-guard.ts — Cred Substrate S5 command handler
 * (ops-568p child)
 *
 * CLI entry point for `tps secrets-guard <cmd> [args...]` and
 * `tps secrets-guard --check`.
 */

import { readManifest } from "../utils/credentials-manifest.js";
import {
  buildFingerprintSet,
  countMatches,
  type FingerprintSet,
  getGuardLogPath,
  spawnGuarded,
} from "../utils/secrets-guard.js";

export interface SecretsGuardArgs {
  action: "guard" | "check";
  cmd?: string;
  args?: string[];
  stdinText?: string;
  noGuard?: boolean;
}

export async function runSecretsGuard(args: SecretsGuardArgs): Promise<void> {
  // Build fingerprint set from manifest
  const manifest = readManifest();
  let set: FingerprintSet;

  if (!manifest) {
    // No manifest → guard runs in shape-only mode.
    // Build via the canonical path so overlapBytes (and any future fields)
    // come from one place instead of being hand-maintained here.
    set = buildFingerprintSet({ version: 1, credentials: {} });
  } else {
    set = buildFingerprintSet(manifest);
  }

  if (args.action === "check") {
    const text = args.stdinText ?? "";
    const n = countMatches(text, set);
    console.log(`matches: ${n}`);
    return;
  }

  // Guard mode: wrap a command
  if (!args.cmd) {
    console.error("Usage: tps secrets-guard <cmd> [args...]");
    process.exit(1);
  }

  if (args.noGuard) {
    // Bypass guard: spawn directly without redaction
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(args.cmd, args.args ?? [], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  const exitCode = await spawnGuarded(
    args.cmd,
    args.args ?? [],
    set,
    getGuardLogPath()
  );

  process.exit(exitCode);
}
