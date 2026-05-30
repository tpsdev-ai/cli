/**
 * agent-keys.ts — Read Ed25519 private key seeds for TPS agents.
 *
 * Keys live in ~/.flair/keys/<agent>.key (mode 0600) in EITHER format the
 * fleet uses:
 *   - a raw 32-byte seed (e.g. flint), or
 *   - base64-encoded PKCS8 DER — the canonical Flair key format used by
 *     kern/sherlock/anvil/pulse and emitted by
 *     `openssl pkcs8 -topk8 -nocrypt -outform DER | base64`.
 *
 * readAgentPrivateKey normalizes both to the 32-byte seed that @noble/ed25519
 * signing expects. Historically it returned the raw file bytes and assumed a
 * 32-byte seed, so signing silently produced invalid signatures for every
 * agent whose key was stored as base64-PKCS8 (all but flint) — breaking
 * `tps mail send` for them. For tests, TPS_TEST_KEYS_DIR overrides the dir.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createPrivateKey } from "node:crypto";

function keysDir(): string {
  if (process.env.TPS_TEST_KEYS_DIR) {
    return process.env.TPS_TEST_KEYS_DIR;
  }
  return join(homedir(), ".flair", "keys");
}

/**
 * Read an agent's Ed25519 private key and return the 32-byte signing seed,
 * normalizing whichever on-disk format the key is stored in (raw seed or
 * base64-PKCS8 DER). Returns null if the key file doesn't exist; throws on an
 * unrecognized format.
 */
export function readAgentPrivateKey(agentName: string): Buffer | null {
  const path = join(keysDir(), `${agentName}.key`);
  if (!existsSync(path)) return null;
  return toEd25519Seed(readFileSync(path));
}

/**
 * Normalize a stored Ed25519 private key to its raw 32-byte seed.
 * Exported for unit tests.
 */
export function toEd25519Seed(raw: Buffer): Buffer {
  // Already a raw 32-byte seed (e.g. flint's key).
  if (raw.length === 32) return raw;

  // base64-encoded PKCS8 DER (canonical Flair key format).
  const text = raw.toString("utf8").trim();
  if (text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const seed = seedFromPkcs8Der(Buffer.from(text, "base64"));
    if (seed) return seed;
  }

  // Raw (non-base64) PKCS8 DER bytes.
  const seed = seedFromPkcs8Der(raw);
  if (seed) return seed;

  throw new Error(
    `Unrecognized Ed25519 private key format (${raw.length} bytes); ` +
      `expected a raw 32-byte seed or base64-encoded PKCS8 DER`,
  );
}

/**
 * Extract the 32-byte Ed25519 seed from PKCS8 DER bytes, validating the
 * structure via node:crypto (no hardcoded ASN.1 offsets). Returns null if the
 * bytes aren't a valid Ed25519 PKCS8 key.
 */
function seedFromPkcs8Der(der: Buffer): Buffer | null {
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    const jwk = key.export({ format: "jwk" }) as { d?: string };
    if (!jwk.d) return null;
    const seed = Buffer.from(jwk.d, "base64url");
    return seed.length === 32 ? seed : null;
  } catch {
    return null;
  }
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
