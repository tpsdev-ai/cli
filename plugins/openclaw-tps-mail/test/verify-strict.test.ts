/**
 * verify-strict.test.ts — Tests for strict signed-envelope verification (ops-ibw8)
 *
 * Covers all 6 attack vectors from TPS-SIGNED-ENVELOPES.md plus happy path.
 * Uses the test-key pattern from packages/cli/test/mail-send-sign.test.ts
 * (seedFromByte, mockFlair). Tests are hermetic — no real Flair HTTP calls.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  signEnvelope,
  verifyEnvelope,
  type Envelope,
  type ChainEntry,
} from "@tpsdev-ai/cli/lib/signEnvelope";

// Wire sha512 for sync sign operations.
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

// ─── Test key fixtures (same pattern as mail-send-sign.test.ts) ─────────

const FLINT_SEED = Buffer.alloc(32, 0x01);
const SHERLOCK_SEED = Buffer.alloc(32, 0x03);
const ROOKIE_SEED = Buffer.alloc(32, 0x07);  // unauthorized agent for injection tests

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

function mockFlair(agentSeeds: Record<string, Buffer>) {
  const pubs: Record<string, Buffer> = {};
  for (const [name, s] of Object.entries(agentSeeds)) {
    pubs[name] = pubkeyFromSeed(s);
  }
  return {
    async getAgent(name: string) {
      const pk = pubs[name];
      return pk ? { publicKey: pk } : null;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMailEnvelope(body: string, overrides: Partial<{ id: string; from: string; to: string }> = {}) {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: overrides.from ?? "flint",
    to: overrides.to ?? "anvil",
    body,
    timestamp: new Date().toISOString(),
    headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
    deliveryAttempts: 0,
  };
}

function readDlqReason(mailDir: string, agentId: string): string | null {
  const dlqDir = resolve(mailDir, agentId, "dlq");
  try {
    const files = readdirSync(dlqDir).filter((f) => f.endsWith(".reason"));
    if (files.length === 0) return null;
    return readFileSync(join(dlqDir, files[0]!), "utf-8").trim();
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function buildSignedEnvelope(
  from: string,
  to: string,
  body: string,
  signerSeeds: Record<string, Buffer>,
  chainEntries?: ChainEntry[],
): Envelope {
  const chain: ChainEntry[] = chainEntries ?? [
    { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: new Date().toISOString(), rationale: `agent ${from} dispatches`, signature: null },
  ];
  return signEnvelope(
    {
      v: 1,
      from,
      to,
      body,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      delegationChain: chain,
    },
    signerSeeds,
  );
}

/**
 * Build a tampered envelope. deep-clone via JCS roundtrip to avoid mutations.
 */
function tamperClone(e: Envelope): Envelope {
  return JSON.parse(canonicalize(e)!) as Envelope;
}

// ─── Plugin harness (replicates startup.test.ts pattern) ────────────────

import pluginModule from "../src/index.js";

let capturedPlugin: any;
const mockPluginApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => {
    capturedPlugin = plugin;
  },
  logger: {
    info: (..._: any[]) => {},
    warn: (..._: any[]) => {},
    error: (..._: any[]) => {},
  },
};
pluginModule.register(mockPluginApi);

// ─── Tests ──────────────────────────────────────────────────────────────

describe("verify-strict: signed envelope verification", () => {
  let tempMailDir: string;
  let abortController: AbortController;
  let dispatchResolve: (val: any) => void;
  let dispatchReject: (err: any) => void;
  let dispatchPromise: Promise<any>;
  let dispatchCount: number;

  beforeEach(() => {
    tempMailDir = mkdtempSync(join(tmpdir(), "tps-verify-"));
    abortController = new AbortController();
    dispatchCount = 0;
    dispatchPromise = new Promise<any>((res, rej) => {
      dispatchResolve = res;
      dispatchReject = rej;
    });
  });

  afterEach(() => {
    abortController.abort();
    try {
      rmSync(tempMailDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /**
   * Start the plugin and wait for either a dispatch (happy path) or
   * a timeout (implies DLQ). Returns the dispatch result or null if
   * nothing was dispatched.
   */
  async function runVerifyTest(
    agentId: string,
    envelope: Envelope,
    flairMock: { getAgent(name: string): Promise<{ publicKey: Buffer } | null> },
  ): Promise<{ dispatched: any | null; dlqReason: string | null }> {
    // Mock the verify-adapter to inject hermetic Flair mock
    mock.module("../src/verify-adapter.js", () => ({
      createVerifyClient: async (_agentId: string) => flairMock,
    }));

    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    // Write the mail file with signed envelope as body
    const msg = makeMailEnvelope(JSON.stringify(envelope), { from: envelope.from, to: agentId });
    const filename = `2026-05-26T00-00-00-${msg.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(msg, null, 2), "utf-8");

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }: any) => {
          dispatchCount++;
          dispatchResolve({ ctx, dispatcherOptions });
        },
      },
    };

    const cfg = {
      bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }],
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    // Wait for dispatch or timeout
    let dispatched: any = null;
    try {
      dispatched = await Promise.race([
        dispatchPromise,
        new Promise<null>((res) => setTimeout(() => res(null), 2000)),
      ]);
    } catch {
      // dispatchReject or timeout
    }

    abortController.abort();
    try { await startPromise; } catch { /* expected on abort */ }

    // Read DLQ reason
    const dlqReason = readDlqReason(tempMailDir, agentId);

    return { dispatched, dlqReason };
  }

  // ── Happy path ──────────────────────────────────────────────────────

  it("dispatches a valid signed envelope (happy path)", async () => {
    const envoy = buildSignedEnvelope("flint", "anvil", "Hello from signed envelope", {
      flint: FLINT_SEED,
    });

    const { dispatched, dlqReason } = await runVerifyTest("anvil", envoy, mockFlair({ flint: FLINT_SEED }));

    expect(dispatched).not.toBeNull();
    expect(dlqReason).toBeNull();
    // Verifies msg.body was replaced with inner body
    expect(dispatched.ctx.Body).toBe("Hello from signed envelope");
    expect(dispatched.ctx.From).toBe("flint");
    expect(dispatchCount).toBe(1);
  });

  // ── Attack vector 1: Forged sender (wrong key signs) ────────────────

  it("dlqs forged sender envelope (wrong key signs)", async () => {
    // Build envelope that claims to be from "flint" but is signed by "rookie"
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: new Date().toISOString(), rationale: "flint dispatches", signature: null },
    ];
    // Sign with ROOKIE's key but claim from=flint
    const forged = signEnvelope(
      {
        v: 1,
        from: "flint",
        to: "anvil",
        body: "I am flint (but really rookie)",
        messageId: `msg-${Date.now()}-rookie`,
        timestamp: new Date().toISOString(),
        delegationChain: chain,
      },
      { flint: FLINT_SEED }, // Signed by flint's key via signer map, but chain says flint
    );
    // Actually to make a true forged-sender: build chain claiming flint, but sign
    // outer envelope with a different key. Let's tamper: sign with rookie as flint.
    // signEnvelope throws on mismatch, so we tamper post-sign.
    // Real attack: rookie signs an envelope claiming to be flint.
    // signEnvelope uses keysByAgent, so if we pass { flint: ROOKIE_SEED }
    // it'll sign with rookie, but the chain says flint — and signEnvelope
    // signs with whatever key is mapped to the chain name.
    // Actually signEnvelope trusts keysByAgent mapping. If we pass
    // { flint: ROOKIE_SEED }, it signs chain entry "flint" with rookies
    // key. The verifier looks up "flint" in Flair and gets FLINTS key —
    // sig won't verify.
    const forgedEnv = signEnvelope(
      {
        v: 1, from: "flint", to: "anvil", body: "forged by rookie",
        messageId: `msg-${Date.now()}-forged`,
        timestamp: new Date().toISOString(),
        delegationChain: [
          { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "orig", signature: null },
          { agent: "flint", kind: "agent", timestamp: new Date().toISOString(), rationale: "flint signs", signature: null },
        ],
      },
      { flint: ROOKIE_SEED }, // Rookie's key pretending to be flint
    );

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", forgedEnv,
      mockFlair({ flint: FLINT_SEED, rookie: ROOKIE_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toContain("signature");
    expect(dispatchCount).toBe(0);
  });

  // ── Attack vector 2: Chain truncation ──────────────────────────────

  it("dlqs truncated chain envelope", async () => {
    // Build valid 2-hop chain
    const fullChain: ChainEntry[] = [
      { agent: "sherlock", kind: "agent", timestamp: new Date().toISOString(), rationale: "sherlock reviews", signature: null },
      { agent: "flint", kind: "agent", timestamp: new Date().toISOString(), rationale: "flint forwards", signature: null },
    ];
    const valid = signEnvelope(
      { v: 1, from: "flint", to: "anvil", body: "two-hop",
        messageId: `msg-${Date.now()}-2hop`, timestamp: new Date().toISOString(),
        delegationChain: fullChain },
      { sherlock: SHERLOCK_SEED, flint: FLINT_SEED },
    );

    // Truncate: drop last entry (flint) but keep outer sigs
    const truncated: Envelope = {
      ...valid,
      delegationChain: [valid.delegationChain[0]], // only sherlock
      // from still says "flint" but chain tip is sherlock → mismatch
    };

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", truncated,
      mockFlair({ flint: FLINT_SEED, sherlock: SHERLOCK_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toMatch(/mismatch/i);
    expect(dispatchCount).toBe(0);
  });

  // ── Attack vector 3: Chain injection ───────────────────────────────

  it("dlqs chain-injected envelope (unauthorized agent inserted)", async () => {
    // Build valid flint envelope
    const valid = buildSignedEnvelope("flint", "anvil", "original", { flint: FLINT_SEED });

    // Inject "rookie" entry unauthorized
    const injected = tamperClone(valid);
    injected.delegationChain.splice(1, 0, {
      agent: "rookie",
      kind: "agent",
      timestamp: new Date().toISOString(),
      rationale: "injected by attacker",
      signature: "ed25519:ZmFrZVNpZ05vdFJlYWw=", // fake sig
    });
    // Update from to match the new chain tip (rookie), keeping flint's original
    // signature which won't verify for rookie

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", injected,
      mockFlair({ flint: FLINT_SEED, rookie: ROOKIE_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toMatch(/signature|mismatch/i);
    expect(dispatchCount).toBe(0);
  });

  // ── Attack vector 4: Adjacent-hop reorder ──────────────────────────

  it("dlqs reordered chain envelope", async () => {
    // Build valid: sherlock → flint → anvil
    const chain: ChainEntry[] = [
      { agent: "sherlock", kind: "agent", timestamp: new Date().toISOString(), rationale: "step 1", signature: null },
      { agent: "flint", kind: "agent", timestamp: new Date().toISOString(), rationale: "step 2", signature: null },
    ];
    const valid = signEnvelope(
      { v: 1, from: "flint", to: "anvil", body: "ordered",
        messageId: `msg-${Date.now()}-ordered`, timestamp: new Date().toISOString(),
        delegationChain: chain },
      { sherlock: SHERLOCK_SEED, flint: FLINT_SEED },
    );

    // Swap entries: flint → sherlock instead of sherlock → flint
    const reordered = tamperClone(valid);
    [reordered.delegationChain[0], reordered.delegationChain[1]] =
      [reordered.delegationChain[1], reordered.delegationChain[0]];

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", reordered,
      mockFlair({ flint: FLINT_SEED, sherlock: SHERLOCK_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toMatch(/signature|mismatch|tip/i);
    expect(dispatchCount).toBe(0);
  });

  // ── Attack vector 5: Tampered rationale ─────────────────────────────

  it("dlqs tampered-rationale envelope", async () => {
    const valid = buildSignedEnvelope("flint", "anvil", "body", { flint: FLINT_SEED });

    // Mutate rationale after signing — sig no longer matches
    const tampered = tamperClone(valid);
    tampered.delegationChain[1].rationale = "CORRUPTED — injected malicious instructions";

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", tampered,
      mockFlair({ flint: FLINT_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toMatch(/signature/i);
    expect(dispatchCount).toBe(0);
  });

  // ── Attack vector 6: Message swap (mutate body after sign) ─────────

  it("dlqs body-swapped envelope", async () => {
    const valid = buildSignedEnvelope("flint", "anvil", "innocent message", { flint: FLINT_SEED });

    // Swap body after signing
    const swapped = tamperClone(valid);
    swapped.body = "rm -rf / --no-preserve-root";

    const { dispatched, dlqReason } = await runVerifyTest(
      "anvil", swapped,
      mockFlair({ flint: FLINT_SEED }),
    );

    expect(dispatched).toBeNull();
    expect(dlqReason).not.toBeNull();
    expect(dlqReason!).toMatch(/signature/i);
    expect(dispatchCount).toBe(0);
  });

  // ── Malformed: not JSON ─────────────────────────────────────────────

  it("dlqs non-JSON body", async () => {
    const agentId = "anvil";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    const msg = makeMailEnvelope("not json at all {{{", { from: "flint" });
    const filename = `2026-05-26T00-00-00-${msg.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(msg, null, 2), "utf-8");

    mock.module("../src/verify-adapter.js", () => ({
      createVerifyClient: async () => mockFlair({ flint: FLINT_SEED }),
    }));

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: any) => {
          dispatchResolve({ ctx });
        },
      },
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg: { bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }] },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    try {
      await Promise.race([
        dispatchPromise,
        new Promise((r) => setTimeout(() => r(null), 2000)),
      ]);
    } catch {}

    abortController.abort();
    try { await startPromise; } catch {}

    const reason = readDlqReason(tempMailDir, agentId);
    expect(reason).not.toBeNull();
    expect(reason!).toContain("not JSON");
    expect(dispatchCount).toBe(0);
  });

  // ── Missing signature field ─────────────────────────────────────────

  it("dlqs envelope without outer signature", async () => {
    const agentId = "anvil";
    const newDir = resolve(tempMailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });

    // Valid envelope structure but missing signature
    const noSig: Partial<Envelope> = {
      v: 1,
      from: "flint",
      to: "anvil",
      body: "no sig",
      messageId: `msg-${Date.now()}-nosig`,
      timestamp: new Date().toISOString(),
      delegationChain: [
        { agent: "system", kind: "human", timestamp: new Date().toISOString(), rationale: "orig", signature: null },
        { agent: "flint", kind: "agent", timestamp: new Date().toISOString(), rationale: "no sig", signature: null },
      ],
    };

    const msg = makeMailEnvelope(JSON.stringify(noSig), { from: "flint" });
    const filename = `2026-05-26T00-00-00-${msg.id}.json`;
    writeFileSync(resolve(newDir, filename), JSON.stringify(msg, null, 2), "utf-8");

    mock.module("../src/verify-adapter.js", () => ({
      createVerifyClient: async () => mockFlair({ flint: FLINT_SEED }),
    }));

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: any) => {
          dispatchResolve({ ctx });
        },
      },
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg: { bindings: [{ agentId, match: { channel: "tps-mail", accountId: "default" } }] },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    try {
      await Promise.race([
        dispatchPromise,
        new Promise((r) => setTimeout(() => r(null), 2000)),
      ]);
    } catch {}

    abortController.abort();
    try { await startPromise; } catch {}

    const reason = readDlqReason(tempMailDir, agentId);
    expect(reason).not.toBeNull();
    expect(reason!).toContain("not a v1 signed envelope");
    expect(dispatchCount).toBe(0);
  });
});
