/**
 * mail-verify.ts — the verify-ready Flair client for mail promotion.
 *
 * The adapter bridges two FlairClient shapes: the CLI's FlairClient returns
 * `FlairAgent.publicKey` as a string, while signEnvelope's verifyEnvelope
 * expects `getAgent()` to return `{ publicKey: Buffer }` (raw 32-byte Ed25519).
 */

import { createFlairClient } from "./flair-client.js";
import { parseFlairPublicKey, PublicKeyFormatError } from "@tpsdev-ai/agent";
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
  bridgeAgentId?: string;
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
      const info = await cliClient.getAgentForVerification(name);
      if (!info) return null;
      // Flair's placeholder until the principal's key is registered: retryable, not malformed.
      if (info.publicKey === "pending") throw new Error(`Flair has no registered public key for ${name} yet (pending)`);
      let publicKey: Buffer;
      try {
        publicKey = parseFlairPublicKey(info.publicKey);
      } catch (err) {
        if (err instanceof PublicKeyFormatError) {
          throw new PublicKeyFormatError(`Flair returned a malformed public key for ${name}`);
        }
        throw err;
      }
      return { publicKey };
    },
  };
}
