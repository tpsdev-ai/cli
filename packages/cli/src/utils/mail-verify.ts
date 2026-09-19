/**
 * mail-verify.ts — the verify-ready Flair client for mail promotion.
 *
 * `promote()` in utils/mail.ts constructs a verifier UNCONDITIONALLY through
 * this module. There is deliberately no client parameter on promote()/
 * checkMessages(): optional verification is exactly how this rotted, and a
 * default is the same hatch wearing a friendlier face.
 *
 * Why this is its own module: it is the one seam the tests replace (bun's
 * `mock.module`) to keep verification hermetic. The live path always calls it —
 * nothing can skip it.
 *
 * The adapter bridges two FlairClient shapes: the CLI's FlairClient returns
 * `FlairAgent.publicKey` as a base64 string, while signEnvelope's verifyEnvelope
 * expects `getAgent()` to return `{ publicKey: Buffer }` (raw 32-byte Ed25519).
 *
 * Reachability matters: `verifyEnvelope` treats a null agent as a verification
 * FAILURE, but a Flair OUTAGE must be classified `verify-unavailable` (retryable)
 * rather than `invalid` (terminal). The CLI's getAgent() swallows network errors
 * into null, so on a null we probe /Health: unreachable → THROW (so promote()
 * can quarantine as verify-unavailable); reachable → genuinely-absent agent.
 */

import { createFlairClient } from "./flair-client.js";
import type { FlairClient as VerifyFlairClient } from "@tpsdev-ai/agent";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where an agent's Flair key lives (override with FLAIR_KEY_PATH). */
export function defaultVerifyKeyPath(agentId: string): string {
  return process.env.FLAIR_KEY_PATH ?? join(homedir(), ".flair", "keys", `${agentId}.key`);
}

/**
 * Runtime-scoped verification configuration.
 *
 * A configuration parameter is NOT a verification bypass: the client is still
 * constructed UNCONDITIONALLY and `promote()`/`checkMessages()` still have no
 * client parameter. This only lets a caller that is not a one-shot CLI process
 * (the agent runtimes) resolve the Flair endpoint it is ALREADY configured to
 * use, instead of inheriting whatever the process-global env happens to hold.
 * Stamping `process.env.FLAIR_URL ??= config.flairUrl` would make the first
 * runtime's values process-wide defaults for every later consumer while each
 * runtime's own FlairClient kept using its explicit config — a divergence, not
 * an alignment. Runtime-scoped configuration keeps one resolution rule per
 * caller.
 */
export interface MailVerifyConfig {
  /** Flair base URL. Falls back to FLAIR_URL, then the local default. */
  flairUrl?: string;
  /** Key path authenticating the verification reads. Falls back to FLAIR_KEY_PATH, then the per-agent default. */
  flairKeyPath?: string;
}

/**
 * Build a FlairClient that verifyEnvelope can use.
 *
 * @param agentId - the mailbox owner (authenticates the Flair reads)
 * @param config  - runtime-scoped endpoint/key override; empty uses env/default
 */
export async function createMailVerifyClient(
  agentId: string,
  config: MailVerifyConfig = {},
): Promise<VerifyFlairClient> {
  const baseUrl = config.flairUrl ?? process.env.FLAIR_URL ?? "http://localhost:9926";
  const keyPath = config.flairKeyPath ?? defaultVerifyKeyPath(agentId);
  const cliClient = createFlairClient(agentId, baseUrl, keyPath);

  return {
    async getAgent(name: string) {
      const info = await cliClient.getAgent(name);
      if (info) return { publicKey: Buffer.from(info.publicKey, "base64") };
      // getAgent() swallows network errors into null. Distinguish "Flair is
      // down" (retryable) from "no such agent" (a real verification failure).
      const reachable = await cliClient.ping();
      if (!reachable) {
        throw new Error(`Flair unreachable at ${baseUrl} while resolving ${name}`);
      }
      return null;
    },
  };
}
