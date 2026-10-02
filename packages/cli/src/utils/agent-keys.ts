/** Shared Ed25519 key rules live in @tpsdev-ai/agent so CLI and MailClient use one resolver. */
export {
  KeyFormatError,
  AgentKeyError,
  AgentKeyConflictError,
  agentKeyCandidates,
  existingAgentKeyPaths,
  resolveAgentKeyPath,
  readAgentPrivateKey,
  readPrivateKeyAtPath,
  toEd25519Seed,
} from "@tpsdev-ai/agent";

/** Parse a prior signed delegation chain from the runtime environment. */
/**
 * Parse TPS_INBOUND_CHAIN_JSON into a ChainEntry array.
 * Returns null if unset, empty, or invalid.
 */
import type { ChainEntry } from "@tpsdev-ai/agent";

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
