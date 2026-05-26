/**
 * verify-adapter.ts — Adapter from @tpsdev-ai/cli FlairClient to signEnvelope.FlairClient
 *
 * The CLI's FlairClient returns `FlairAgent.publicKey` as a base64-encoded
 * string. signEnvelope's verifyEnvelope expects `getAgent()` to return
 * `{ publicKey: Buffer }` (raw 32-byte Ed25519 key).
 *
 * This module bridges the two: it wraps a CLI FlairClient and base64-decodes
 * the publicKey string into a Buffer at the adapter boundary. This ensures
 * verifyEnvelope never sees the raw base64 string as a Buffer — which was the
 * PR-4 round-1 bug where raw base64 bytes (not decoded) were fed to
 * createPublicKey({type:'spki'}).
 */

import { FlairClient as CliFlairClient, createFlairClient } from "@tpsdev-ai/cli/utils/flair-client";
import type { FlairClient as VerifyFlairClient } from "@tpsdev-ai/cli/lib/signEnvelope";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultKeyPath(agentId: string): string {
  return join(homedir(), ".flair", "keys", `${agentId}.key`);
}

/**
 * Create a verify-ready FlairClient for the given agent.
 *
 * Lazily constructs a CLI FlairClient (which hits the real Flair HTTP API)
 * and wraps it to return Buffers instead of base64 strings.
 *
 * @param agentId - The recipient agent whose key to use for Flair auth
 * @returns A FlairClient compatible with verifyEnvelope
 */
export async function createVerifyClient(agentId: string): Promise<VerifyFlairClient> {
  const keyPath = process.env.FLAIR_KEY_PATH ?? defaultKeyPath(agentId);
  const baseUrl = process.env.FLAIR_URL ?? "http://localhost:9926";

  const cliClient = createFlairClient(agentId, baseUrl, keyPath);

  return {
    async getAgent(name: string) {
      try {
        const info = await cliClient.getAgent(name);
        if (!info) return null;
        // Base64-decode the publicKey string → Buffer (raw 32-byte Ed25519 key)
        return { publicKey: Buffer.from(info.publicKey, "base64") };
      } catch {
        return null;
      }
    },
  };
}
