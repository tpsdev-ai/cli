/**
 * signEnvelope.test.ts — Tests for signEnvelope()
 */

import { describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { signEnvelope, type Envelope, type ChainEntry } from "../src/lib/signEnvelope.js";

// Wire sha512 for sync sign operations (same as production).
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a 32-byte seed from a repeated hex byte (e.g., 0x01 -> 32 bytes of 0x01). */
function seedFromByte(b: number): Buffer {
  return Buffer.alloc(32, b);
}

/** Sign payload the same way signEnvelope does, for fixture generation. */
function signFixture(payload: Uint8Array, seed: Buffer): string {
  const sig = ed.sign(payload, new Uint8Array(seed));
  return `ed25519:${Buffer.from(sig).toString("base64")}`;
}

/** Build a minimal valid envelope. */
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

// Flint's seed = 32 bytes of 0x01
const FLINT_SEED = seedFromByte(0x01);

// Nathan's key (not actually used for signing — human)
const NATHAN_SEED = seedFromByte(0x02);

// Sherlock's seed
const SHERLOCK_SEED = seedFromByte(0x03);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("signEnvelope", () => {
  // ── Test 1: Worked-example forward path ───────────────────────────────

  test("signs a Nathan→Flint envelope with correct chain + outer signatures", () => {
    const chain: ChainEntry[] = [
      {
        agent: "nathan",
        kind: "human",
        timestamp: "2026-05-24T11:00:00.000Z",
        rationale: "Nathan originates the request",
        signature: null,
      },
      {
        agent: "flint",
        kind: "agent",
        timestamp: "2026-05-24T11:05:00.000Z",
        rationale: "Flint dispatches to anvil",
        signature: null,
      },
    ];

    const envelope = makeEnvelope({
      from: "flint",
      to: "anvil",
      subject: "Dispatch PR-1",
      body: "Build signEnvelope()",
      messageId: "msg-pr1-001",
      timestamp: "2026-05-24T11:05:00.000Z",
      chain,
    });

    const result = signEnvelope(envelope, { flint: FLINT_SEED });

    // Verify Flint's chain entry was signed
    expect(result.delegationChain[0].signature).toBeNull(); // nathan = human
    expect(result.delegationChain[1].signature).not.toBeNull();
    expect(result.delegationChain[1].signature).toMatch(/^ed25519:/);

    // Verify outer signature exists
    expect(result.signature).not.toBeUndefined();
    expect(result.signature).toMatch(/^ed25519:/);

    // Verify chain entry sig is correct — recompute expected
    const expectedChainEntryPayload = {
      prior: [result.delegationChain[0]],
      entry: {
        agent: "flint",
        kind: "agent",
        timestamp: "2026-05-24T11:05:00.000Z",
        rationale: "Flint dispatches to anvil",
        signature: undefined,
      },
    };
    const expectedChainSig = signFixture(
      new TextEncoder().encode(canonicalize(expectedChainEntryPayload)!),
      FLINT_SEED,
    );
    expect(result.delegationChain[1].signature).toBe(expectedChainSig);

    // Verify outer sig is correct
    const { signature: _, ...envelopeWithoutSig } = result;
    const expectedOuterSig = signFixture(
      new TextEncoder().encode(canonicalize(envelopeWithoutSig)!),
      FLINT_SEED,
    );
    expect(result.signature).toBe(expectedOuterSig);

    // Original input not mutated
    expect(envelope.signature).toBeUndefined();
    expect(envelope.delegationChain[0].signature).toBeNull();
    expect(envelope.delegationChain[1].signature).toBeNull();
  });

  // ── Test 2: Sub-dispatch chain growth ─────────────────────────────────

  test("preserves prior sigs when adding new chain entry (idempotent re-sign)", () => {
    // Step 1: sign as Flint
    const nathanEntry: ChainEntry = {
      agent: "nathan",
      kind: "human",
      timestamp: "2026-05-24T11:00:00.000Z",
      rationale: "Nathan originates",
      signature: null,
    };
    const flintEntry: ChainEntry = {
      agent: "flint",
      kind: "agent",
      timestamp: "2026-05-24T11:05:00.000Z",
      rationale: "Flint signs off",
      signature: null,
    };

    const flintSigned = signEnvelope(
      makeEnvelope({
        from: "flint",
        to: "sherlock",
        subject: "Sub-dispatch",
        body: "Forward this",
        messageId: "msg-chain-001",
        chain: [nathanEntry, flintEntry],
      }),
      { flint: FLINT_SEED },
    );

    const flintChainSig = flintSigned.delegationChain[1].signature;
    expect(flintChainSig).not.toBeNull();

    // Step 2: Sherlock appends their entry and re-signs
    const sherlockEntry: ChainEntry = {
      agent: "sherlock",
      kind: "agent",
      timestamp: "2026-05-24T11:10:00.000Z",
      rationale: "Sherlock reviews and forwards to anvil",
      signature: null,
    };

    const result = signEnvelope(
      makeEnvelope({
        from: "sherlock",
        to: "anvil",
        subject: "Sub-dispatch",
        body: "Forward this",
        messageId: "msg-chain-001",
        chain: [...flintSigned.delegationChain, sherlockEntry],
      }),
      { flint: FLINT_SEED, sherlock: SHERLOCK_SEED },
    );

    // Flint's prior sig preserved unchanged
    expect(result.delegationChain[1].signature).toBe(flintChainSig);

    // Sherlock's entry now signed
    expect(result.delegationChain[2].signature).not.toBeNull();
    expect(result.delegationChain[2].signature).toMatch(/^ed25519:/);

    // Verify Sherlock's chain entry sig
    const expectedSherlockSig = signFixture(
      new TextEncoder().encode(
        canonicalize({
          prior: result.delegationChain.slice(0, 2),
          entry: {
            agent: "sherlock",
            kind: "agent",
            timestamp: "2026-05-24T11:10:00.000Z",
            rationale: "Sherlock reviews and forwards to anvil",
            signature: undefined,
          },
        })!,
      ),
      SHERLOCK_SEED,
    );
    expect(result.delegationChain[2].signature).toBe(expectedSherlockSig);

    // Outer sig uses Sherlock's key
    expect(result.signature).not.toBeUndefined();
  });

  // ── Test 3: Throws on chain tip mismatch ──────────────────────────────

  test("throws when envelope.from does not match chain tip agent", () => {
    const chain: ChainEntry[] = [
      {
        agent: "sherlock",
        kind: "agent",
        timestamp: "2026-05-24T11:00:00.000Z",
        rationale: "Sherlock signed",
        signature: null,
      },
    ];

    const envelope = makeEnvelope({
      from: "flint", // mismatch: chain tip is sherlock
      to: "anvil",
      chain,
    });

    expect(() => signEnvelope(envelope, {
      sherlock: SHERLOCK_SEED,
      flint: FLINT_SEED,
    })).toThrow(/from.*flint.*must equal.*chain tip.*sherlock/i);
  });

  // ── Test 4: Throws on missing privkey ─────────────────────────────────

  test("throws when keysByAgent is missing a required key", () => {
    const chain: ChainEntry[] = [
      {
        agent: "nathan",
        kind: "human",
        timestamp: "2026-05-24T11:00:00.000Z",
        rationale: "Nathan originates",
        signature: null,
      },
      {
        agent: "flint",
        kind: "agent",
        timestamp: "2026-05-24T11:05:00.000Z",
        rationale: "Flint dispatches",
        signature: null,
      },
    ];

    const envelope = makeEnvelope({
      from: "flint",
      to: "anvil",
      chain,
    });

    // nathan is human — no key needed. But flint's key IS needed.
    expect(() => signEnvelope(envelope, { nathan: NATHAN_SEED })).toThrow(
      /Missing private key for agent "flint"/,
    );
  });

  // ── Test 5: Throws on human entry with non-null signature ─────────────

  test("throws when a human-kind chain entry has a non-null signature", () => {
    const chain: ChainEntry[] = [
      {
        agent: "nathan",
        kind: "human",
        timestamp: "2026-05-24T11:00:00.000Z",
        rationale: "Nathan originates",
        signature: "ed25519:ZmFrZQ==", // human should NOT have a sig
      },
      {
        agent: "flint",
        kind: "agent",
        timestamp: "2026-05-24T11:05:00.000Z",
        rationale: "Flint dispatches",
        signature: null,
      },
    ];

    const envelope = makeEnvelope({
      from: "flint",
      to: "anvil",
      chain,
    });

    expect(() => signEnvelope(envelope, { flint: FLINT_SEED })).toThrow(
      /Human-kind chain entry.*nathan.*must have null signature/i,
    );
  });
});
