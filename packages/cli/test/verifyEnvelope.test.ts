/**
 * verifyEnvelope.test.ts — Tests for verifyEnvelope()
 */

import { describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  signEnvelope,
  verifyEnvelope,
  type Envelope,
  type ChainEntry,
  type FlairClient,
} from "../src/lib/signEnvelope.js";

// Wire sha512 for sync sign operations (same as production).
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedFromByte(b: number): Buffer {
  return Buffer.alloc(32, b);
}

/** Derive public key from seed (32 bytes). */
function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

/** Build a mock FlairClient from a map of seed bytes. */
function mockFlair(agentSeeds: Record<string, Buffer>): FlairClient {
  const pubs: Record<string, Buffer> = {};
  for (const [name, seed] of Object.entries(agentSeeds)) {
    pubs[name] = pubkeyFromSeed(seed);
  }
  return {
    async getAgent(name: string) {
      const pk = pubs[name];
      return pk ? { publicKey: pk } : null;
    },
  };
}

function makeEnvelope(overrides: Partial<Envelope> & {
  from: string;
  chain: ChainEntry[];
}): Envelope {
  return {
    v: 1,
    to: overrides.to ?? "anvil",
    subject: overrides.subject ?? "Test envelope",
    body: overrides.body ?? "Hello from test",
    messageId: overrides.messageId ?? "msg-test-001",
    timestamp: overrides.timestamp ?? "2026-05-24T12:00:00.000Z",
    delegationChain: overrides.chain,
    ...overrides,
  };
}

// ─── Test fixtures ─────────────────────────────────────────────────────────

const FLINT_SEED = seedFromByte(0x01);
const SHERLOCK_SEED = seedFromByte(0x03);
const RESEARCH_SEED = seedFromByte(0x04);
const ATTACKER_SEED = seedFromByte(0xff);

const FLINT_PUB = pubkeyFromSeed(FLINT_SEED);
const SHERLOCK_PUB = pubkeyFromSeed(SHERLOCK_SEED);
const RESEARCH_PUB = pubkeyFromSeed(RESEARCH_SEED);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("verifyEnvelope", () => {
  // ── Test 1: Happy path ────────────────────────────────────────────────

  test("verifies a signed envelope (Nathan→Flint) returns ok:true", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const envelope = makeEnvelope({ from: "flint", to: "anvil", chain });
    const signed = signEnvelope(envelope, { flint: FLINT_SEED });

    const result = await verifyEnvelope(signed, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: true });
  });

  // ── Test 2: 3-hop chain ───────────────────────────────────────────────

  test("verifies a 3-hop signed chain (Nathan→Flint→Sherlock→research-agent)", async () => {
    // Hop 1: Nathan→Flint
    const chain1: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const e1 = signEnvelope(makeEnvelope({ from: "flint", to: "sherlock", messageId: "hop1", chain: chain1 }), { flint: FLINT_SEED });

    // Hop 2: Flint→Sherlock (re-signs with Sherlock's key)
    const chain2: ChainEntry[] = [
      ...e1.delegationChain,
      { agent: "sherlock", kind: "agent", timestamp: "2026-05-24T11:10:00.000Z", rationale: "Reviews", signature: null },
    ];
    const e2 = signEnvelope(makeEnvelope({ from: "sherlock", to: "research-agent", messageId: "hop2", chain: chain2 }), { flint: FLINT_SEED, sherlock: SHERLOCK_SEED });

    // Hop 3: Sherlock→research-agent (re-signs with research-agent's key)
    const chain3: ChainEntry[] = [
      ...e2.delegationChain,
      { agent: "research-agent", kind: "agent", timestamp: "2026-05-24T11:15:00.000Z", rationale: "Researches", signature: null },
    ];
    const e3 = signEnvelope(makeEnvelope({ from: "research-agent", to: "anvil", messageId: "hop3", chain: chain3 }), {
      flint: FLINT_SEED,
      sherlock: SHERLOCK_SEED,
      "research-agent": RESEARCH_SEED,
    });

    const result = await verifyEnvelope(e3, mockFlair({
      flint: FLINT_SEED,
      sherlock: SHERLOCK_SEED,
      "research-agent": RESEARCH_SEED,
    }));
    expect(result).toEqual({ ok: true });
  });

  // ── Test 3: Forged sender ─────────────────────────────────────────────

  test("rejects forged sender (from changed without re-signing)", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({ from: "flint", to: "anvil", chain }), { flint: FLINT_SEED });

    // Forge: replace from + chain tip agent with "attacker", keep flint's sigs.
    // Chain entry 1 sig was computed over { entry: { agent: "flint", ... } }
    // but the entry now reads "attacker" — chain entry sig fails first.
    const forgedChain = [...signed.delegationChain];
    forgedChain[1] = { ...forgedChain[1], agent: "attacker" };
    const forged = { ...signed, from: "attacker", delegationChain: forgedChain };

    const result = await verifyEnvelope(forged, mockFlair({
      flint: FLINT_SEED,
      attacker: ATTACKER_SEED,
    }));
    expect(result).toEqual({ ok: false, reason: "chain entry 1 signature invalid" });
  });

  // ── Test 4: Chain truncation ──────────────────────────────────────────

  test("rejects truncated chain (dropped entry, inner sig becomes invalid)", async () => {
    // Sign with 2 entries in chain (nathan + flint)
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({ from: "flint", to: "anvil", chain }), { flint: FLINT_SEED });

    // Truncate: drop nathan entry and re-sign outer with flint's key
    // Flint's chain entry sig was over (nathan-only prior + flint),
    // but now prior is empty (since nathan was dropped).
    const truncatedChain = [signed.delegationChain[1]]; // just flint
    const truncated = { ...signed, delegationChain: truncatedChain };

    // Re-sign outer to make it valid; inner flint sig is now wrong
    const { signature: _, ...envWithoutSig } = truncated;
    const newOuterCanonical = canonicalize(envWithoutSig);
    const { sign } = await import("@noble/ed25519");
    const newOuterSig = sign(
      new TextEncoder().encode(newOuterCanonical!),
      new Uint8Array(FLINT_SEED),
    );

    const tampered = {
      ...truncated,
      signature: `ed25519:${Buffer.from(newOuterSig).toString("base64")}`,
    };

    const result = await verifyEnvelope(tampered, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: false, reason: "chain entry 0 signature invalid" });
  });

  // ── Test 5: Chain injection ───────────────────────────────────────────

  test("rejects injected fake entry in middle of chain", async () => {
    // Original: nathan→flint (2 entries)
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({ from: "flint", to: "anvil", chain }), { flint: FLINT_SEED });

    // Inject fake sherlock entry between nathan and flint
    const fakeEntry: ChainEntry = {
      agent: "sherlock",
      kind: "agent",
      timestamp: "2026-05-24T11:03:00.000Z",
      rationale: "Fake review",
      signature: "ed25519:AAAA", // bogus sig
    };
    const injectedChain = [signed.delegationChain[0], fakeEntry, signed.delegationChain[1]];
    const injected = { ...signed, delegationChain: injectedChain };

    const result = await verifyEnvelope(injected, mockFlair({
      flint: FLINT_SEED,
      sherlock: SHERLOCK_SEED,
    }));
    // Either flint's entry sig (index 2) or sherlock's fake sig (index 1) fails first —
    // sherlock's fake sig at entry 1 should fail since "ed25519:AAAA" is bogus
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  // ── Test 6: Adjacent-hop reorder ──────────────────────────────────────

  test("rejects reordered chain entries (swapped hops)", async () => {
    // Build 3-hop chain: nathan(human) → flint → sherlock
    const chain1: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const e1 = signEnvelope(makeEnvelope({ from: "flint", to: "sherlock", messageId: "reorder", chain: chain1 }), { flint: FLINT_SEED });

    const chain2: ChainEntry[] = [
      ...e1.delegationChain,
      { agent: "sherlock", kind: "agent", timestamp: "2026-05-24T11:10:00.000Z", rationale: "Reviews", signature: null },
    ];
    const e2 = signEnvelope(makeEnvelope({ from: "sherlock", to: "anvil", messageId: "reorder", chain: chain2 }), {
      flint: FLINT_SEED, sherlock: SHERLOCK_SEED,
    });

    // Swap flint (index 1) and sherlock (index 2); update from to match new chain tip
    const reorderedChain = [
      e2.delegationChain[0], // nathan
      e2.delegationChain[2], // sherlock (was at 2, now at 1)
      e2.delegationChain[1], // flint (was at 1, now at 2 — new chain tip)
    ];
    const reordered = { ...e2, from: "flint", delegationChain: reorderedChain };

    const result = await verifyEnvelope(reordered, mockFlair({
      flint: FLINT_SEED, sherlock: SHERLOCK_SEED,
    }));
    // sherlock's sig was over (nathan + flint + sherlock_no_sig), but
    // now in position 1, prior is [nathan] — sig mismatch
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason");
    // The reason pattern should be "chain entry 1 signature invalid" or similar
    if (result.ok === false) {
      expect(result.reason).toMatch(/chain entry \d+ signature invalid/);
    }
  });

  // ── Test 7: Tampered rationale ────────────────────────────────────────

  test("rejects tampered rationale in a prior entry", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({ from: "flint", to: "anvil", chain }), { flint: FLINT_SEED });

    // Tamper: change flint's rationale after signing
    const tamperedChain = [...signed.delegationChain];
    tamperedChain[1] = { ...tamperedChain[1], rationale: "I am an imposter" };
    const tampered = { ...signed, delegationChain: tamperedChain };

    const result = await verifyEnvelope(tampered, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: false, reason: "chain entry 1 signature invalid" });
  });

  // ── Test 8: Message swap ──────────────────────────────────────────────

  test("rejects swapped body (outer sig invalid)", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({
      from: "flint", to: "anvil", body: "Build signEnvelope()", chain,
    }), { flint: FLINT_SEED });

    // Swap the body
    const swapped = { ...signed, body: "DELETE ALL THE THINGS" };

    const result = await verifyEnvelope(swapped, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: false, reason: "outer signature invalid" });
  });

  // ── Test 9: Chain too long ────────────────────────────────────────────

  test("rejects chain with 17 hops", async () => {
    // Build a 17-hop chain of agent entries
    const chain: ChainEntry[] = [];
    for (let i = 0; i < 17; i++) {
      chain.push({
        agent: `agent-${i}`,
        kind: "agent",
        timestamp: new Date(Date.UTC(2026, 4, 24, 11, i)).toISOString(),
        rationale: `Hop ${i}`,
        signature: null,
      });
    }

    const envelope = makeEnvelope({ from: "agent-16", to: "anvil", chain });

    const result = await verifyEnvelope(envelope, mockFlair({}));
    expect(result).toEqual({ ok: false, reason: "chain too long" });
  });

  // ── Test 10: Agent not in Flair ───────────────────────────────────────

  test("rejects when agent pubkey is not in Flair", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const signed = signEnvelope(makeEnvelope({ from: "flint", to: "anvil", chain }), { flint: FLINT_SEED });

    // flairClient has no keys at all
    const result = await verifyEnvelope(signed, mockFlair({}));
    expect(result).toEqual({ ok: false, reason: "agent flint not found in Flair" });
  });

  // ── Test 11: Human entry with non-null signature ──────────────────────

  test("rejects human entry with non-null signature", async () => {
    const chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: "ed25519:ZmFrZQ==" },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const envelope = makeEnvelope({ from: "flint", to: "anvil", chain });

    const result = await verifyEnvelope(envelope, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: false, reason: "human entry must have null signature" });
  });

  // ── Test 12: Unsupported version ──────────────────────────────────────

  test("rejects envelope with v=2", async () => {
    const chain: ChainEntry[] = [
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const envelope = makeEnvelope({ v: 2, from: "flint", to: "anvil", chain });

    const result = await verifyEnvelope(envelope, mockFlair({ flint: FLINT_SEED }));
    expect(result).toEqual({ ok: false, reason: "unsupported version" });
  });
});
