/**
 * agent-keys.ts — Read Ed25519 private key seeds for TPS agents.
 *
 * Keys are stored as 32-byte raw seeds in ~/.flair/keys/<agent>.key
 * (mode 0600). For tests, TPS_TEST_KEYS_DIR overrides the key directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function keysDir(): string {
  if (process.env.TPS_TEST_KEYS_DIR) {
    return process.env.TPS_TEST_KEYS_DIR;
  }
  return join(homedir(), ".flair", "keys");
}

/**
 * Read an agent's Ed25519 private key seed (32 bytes).
 * Returns null if the key file doesn't exist.
 */
export function readAgentPrivateKey(agentName: string): Buffer | null {
  const path = join(keysDir(), `${agentName}.key`);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/**
 * Parse TPS_INBOUND_CHAIN_JSON into a ChainEntry array.
 * Returns null if unset, empty, or invalid.
 */
import type { ChainEntry } from "../lib/signEnvelope.js";

export function parseInboundChain(raw: string | undefined): ChainEntry[] | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Basic shape validation: every entry must have agent, kind, timestamp, rationale
    for (const entry of parsed) {
      if (
        typeof entry !== "object" ||
        typeof entry.agent !== "string" ||
        typeof entry.kind !== "string" ||
        typeof entry.timestamp !== "string" ||
        typeof entry.rationale !== "string"
      ) {
        return null;
      }
      if (entry.kind !== "human" && entry.kind !== "agent") return null;
      if (entry.signature !== null && entry.signature !== undefined && typeof entry.signature !== "string") return null;
    }
    return parsed as ChainEntry[];
  } catch {
    return null;
  }
}
