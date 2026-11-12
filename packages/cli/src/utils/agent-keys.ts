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

/**
 * Parse TPS_INBOUND_CHAIN_JSON into a ChainEntry array.
 * Returns null if unset, empty, not a JSON array, or a reached entry has a
 * non-string agent, timestamp or rationale, or a kind other than "human" or
 * "agent".
 * Throws InboundChainShapeError for a hop whose signature is not the one its
 * kind carries in a signed envelope: null for a human hop, a string for an
 * agent hop. Those shapes would make the fresh send fail or store a chain a
 * re-send cannot match, so they are refused rather than replaced by the
 * default chain.
 */
import type { ChainEntry } from "@tpsdev-ai/agent";

export class InboundChainShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundChainShapeError";
  }
}

export function parseInboundChain(raw: string | undefined): ChainEntry[] | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Basic shape validation: every entry must have agent, kind, timestamp, rationale
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.agent !== "string" ||
        typeof entry.kind !== "string" ||
        typeof entry.timestamp !== "string" ||
        typeof entry.rationale !== "string"
      ) {
        return null;
      }
      if (entry.kind !== "human" && entry.kind !== "agent") return null;
      if (entry.kind === "human" && entry.signature !== null) {
        throw new InboundChainShapeError(
          `inbound delegation chain hop ${i} for "${entry.agent}" is human-kind and must have a null signature`,
        );
      }
      if (entry.kind === "agent" && typeof entry.signature !== "string") {
        throw new InboundChainShapeError(
          `inbound delegation chain hop ${i} for "${entry.agent}" is agent-kind and must carry its signature string`,
        );
      }
    }
    return parsed as ChainEntry[];
  } catch (error) {
    if (error instanceof InboundChainShapeError) throw error;
    return null;
  }
}
