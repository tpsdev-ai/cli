/**
 * signEnvelope — Ed25519 signature over TPS mail envelope + delegation chain.
 *
 * Signs every agent-kind entry in the delegation chain whose signature is
 * null/missing, then signs the outer envelope. Uses JCS (RFC 8785)
 * canonicalization for deterministic byte-level signing input.
 */

import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

// Ensure sync sha512 is wired (same pattern as identity.ts).
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChainEntry {
  agent: string;
  kind: "human" | "agent";
  timestamp: string; // ISO-8601 UTC
  rationale: string;
  signature: string | null; // "ed25519:<base64>" or null for human
}

export interface Envelope {
  v: number;
  from: string;
  to: string;
  subject?: string;
  body: string;
  messageId: string;
  timestamp: string;
  delegationChain: ChainEntry[];
  signature?: string; // populated by signEnvelope
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function base64Encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function base64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * Sign payload bytes with an Ed25519 seed (32 bytes).
 * Returns a 64-byte signature.
 */
function signPayload(payload: Uint8Array, seed: Uint8Array): Uint8Array {
  return ed.sign(payload, seed);
}

/**
 * Verify an Ed25519 signature against a payload and public key.
 */
function verifyPayload(
  payload: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed.verify(signature, payload, publicKey);
  } catch {
    return false;
  }
}

/**
 * Decode a "ed25519:<base64>" signature string into raw bytes.
 * Returns null if the signature is null/undefined or malformed.
 */
function decodeSignature(sig: string | null | undefined): Uint8Array | null {
  if (sig == null) return null;
  const prefix = "ed25519:";
  if (!sig.startsWith(prefix)) return null;
  try {
    return base64Decode(sig.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * Deep-clone an envelope so we never mutate the input.
 */
function cloneEnvelope(e: Envelope): Envelope {
  return JSON.parse(JSON.stringify(e)) as Envelope;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Sign an envelope:
 * - For each agent-kind chain entry whose signature is null/missing, generate
 *   sig over jcs({ prior: chain[0..i], entry: { ...entry, signature: undefined } })
 *   using the agent's privkey.
 * - Then compute outer sig over jcs({ ...envelope, signature: undefined })
 *   using the LAST chain entry's privkey (which must equal envelope.from).
 *
 * Caller passes privkeys by agent name. For PR-1 simplicity, accept a map:
 *   keysByAgent: { [agentName: string]: Buffer (32-byte Ed25519 seed) }
 *
 * Returns envelope with chain entry sigs and outer sig populated.
 * Mutates a copy, does not mutate input.
 */
export function signEnvelope(
  envelope: Envelope,
  keysByAgent: Record<string, Buffer>,
): Envelope {
  const chain = envelope.delegationChain;

  // ── Validation ────────────────────────────────────────────────────────

  // 1. Chain tip must match envelope.from
  const chainTip = chain[chain.length - 1];
  if (!chainTip || chainTip.agent !== envelope.from) {
    throw new Error(
      `Envelope from "${envelope.from}" must equal delegation chain tip agent "${chainTip?.agent ?? "(empty chain)"}"`,
    );
  }

  // 2. Check human entries don't have signatures
  for (const entry of chain) {
    if (entry.kind === "human" && entry.signature !== null) {
      throw new Error(
        `Human-kind chain entry for "${entry.agent}" must have null signature`,
      );
    }
  }

  // 3. Collect all agents that need a private key
  const agentsNeedingKey = new Set<string>();
  for (const entry of chain) {
    if (entry.kind === "agent" && entry.signature === null) {
      agentsNeedingKey.add(entry.agent);
    }
  }
  // Outer sig always needs envelope.from's key
  agentsNeedingKey.add(envelope.from);

  for (const agent of agentsNeedingKey) {
    if (!keysByAgent[agent]) {
      throw new Error(
        `Missing private key for agent "${agent}"`,
      );
    }
  }

  // ── Sign chain entries ────────────────────────────────────────────────

  const result = cloneEnvelope(envelope);
  const resultChain = result.delegationChain;

  for (let i = 0; i < resultChain.length; i++) {
    const entry = resultChain[i];
    if (entry.kind !== "agent") continue;
    if (entry.signature !== null) continue; // idempotent: skip already-signed

    // Build signing payload: { prior: chain[0..i], entry: { ...entry, signature: undefined } }
    const prior = resultChain.slice(0, i);
    const entryForSig = {
      agent: entry.agent,
      kind: entry.kind,
      timestamp: entry.timestamp,
      rationale: entry.rationale,
      signature: undefined,
    } as const;
    const payload = { prior, entry: entryForSig };

    const canonical = canonicalize(payload);
    if (canonical === undefined) {
      throw new Error(`Failed to canonicalize chain entry payload for agent "${entry.agent}"`);
    }

    const payloadBuf = new TextEncoder().encode(canonical);
    const seed = new Uint8Array(keysByAgent[entry.agent]);
    const sig = signPayload(payloadBuf, seed);
    entry.signature = `ed25519:${base64Encode(sig)}`;
  }

  // ── Sign outer envelope ───────────────────────────────────────────────

  const { signature: _, ...envelopeWithoutSig } = result;
  const canonical = canonicalize(envelopeWithoutSig);
  if (canonical === undefined) {
    throw new Error("Failed to canonicalize outer envelope");
  }

  const payloadBuf = new TextEncoder().encode(canonical);
  const fromSeed = new Uint8Array(keysByAgent[envelope.from]);
  const outerSig = signPayload(payloadBuf, fromSeed);
  result.signature = `ed25519:${base64Encode(outerSig)}`;

  return result;
}

// ─── Flair client interface (dependency-injected) ──────────────────────────

export interface FlairClient {
  getAgent(name: string): Promise<{ publicKey: Buffer } | null>;
}

// ─── Verify result types ────────────────────────────────────────────────────

export interface VerifyOk {
  ok: true;
}

export interface VerifyReject {
  ok: false;
  reason: string;
}

/**
 * Verify a signed envelope:
 * - v must be 1
 * - delegationChain must be non-empty and length <= 16
 * - last chain entry's agent must equal envelope.from
 * - outer signature must verify against envelope.from's pubkey over
 *   jcs({ ...envelope, signature: undefined })
 * - each agent-kind chain entry's signature must verify against that
 *   agent's pubkey over jcs({ prior: chain[0..i], entry: { ...entry, signature: undefined } })
 * - each human-kind entry must have signature === null
 *
 * Pure function with DI'd flairClient — no Flair HTTP coupling.
 */
export async function verifyEnvelope(
  envelope: Envelope,
  flairClient: FlairClient,
): Promise<VerifyOk | VerifyReject> {
  // 1. Version check
  if (envelope.v !== 1) {
    return { ok: false, reason: "unsupported version" };
  }

  // 2. Chain must exist and be non-empty
  const chain = envelope.delegationChain;
  if (!chain || chain.length === 0) {
    return { ok: false, reason: "missing chain" };
  }

  // 3. Chain length limit
  if (chain.length > 16) {
    return { ok: false, reason: "chain too long" };
  }

  // 4. Chain tip must match envelope.from
  if (chain[chain.length - 1].agent !== envelope.from) {
    return { ok: false, reason: "chain tip / from mismatch" };
  }

  // 5. Human entries must have null signature
  for (const entry of chain) {
    if (entry.kind === "human" && entry.signature !== null) {
      return { ok: false, reason: "human entry must have null signature" };
    }
  }

  // 6. Resolve all agent pubkeys from Flair
  const pubkeys = new Map<string, Buffer>();
  const agentsToResolve = new Set<string>();
  for (const entry of chain) {
    if (entry.kind === "agent") agentsToResolve.add(entry.agent);
  }
  agentsToResolve.add(envelope.from);

  for (const agent of agentsToResolve) {
    const info = await flairClient.getAgent(agent);
    if (!info) {
      return { ok: false, reason: `agent ${agent} not found in Flair` };
    }
    pubkeys.set(agent, info.publicKey);
  }

  // 7. Verify each agent-kind chain entry signature
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (entry.kind !== "agent") continue;

    const sigBytes = decodeSignature(entry.signature);
    if (!sigBytes) {
      return { ok: false, reason: `chain entry ${i} signature invalid` };
    }

    const prior = chain.slice(0, i);
    const entryForSig = {
      agent: entry.agent,
      kind: entry.kind,
      timestamp: entry.timestamp,
      rationale: entry.rationale,
      signature: undefined,
    } as const;
    const payload = { prior, entry: entryForSig };

    const canonical = canonicalize(payload);
    if (canonical === undefined) {
      return { ok: false, reason: `chain entry ${i} signature invalid` };
    }

    const payloadBuf = new TextEncoder().encode(canonical);
    const pubKey = pubkeys.get(entry.agent)!;
    if (!verifyPayload(payloadBuf, sigBytes, new Uint8Array(pubKey))) {
      return { ok: false, reason: `chain entry ${i} signature invalid` };
    }
  }

  // 8. Verify outer signature
  const sigBytes = decodeSignature(envelope.signature);
  if (!sigBytes) {
    return { ok: false, reason: "outer signature invalid" };
  }

  const { signature: _, ...envelopeWithoutSig } = envelope;
  const canonical = canonicalize(envelopeWithoutSig);
  if (canonical === undefined) {
    return { ok: false, reason: "outer signature invalid" };
  }

  const payloadBuf = new TextEncoder().encode(canonical);
  const fromPubKey = pubkeys.get(envelope.from)!;
  if (!verifyPayload(payloadBuf, sigBytes, new Uint8Array(fromPubKey))) {
    return { ok: false, reason: "outer signature invalid" };
  }

  return { ok: true };
}
