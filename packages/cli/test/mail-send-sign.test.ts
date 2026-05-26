/**
 * mail-send-sign.test.ts — Tests for signed-envelope mail send (PR-3)
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  verifyEnvelope,
  signEnvelope,
  type Envelope,
  type ChainEntry,
} from "../src/lib/signEnvelope.js";

// Wire sha512 for sync sign operations.
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedFromByte(b: number): Buffer {
  return Buffer.alloc(32, b);
}

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

function runMailSend(args: string[], env: Record<string, string>) {
  const home = env.HOME ?? join(env.TPS_MAIL_DIR ? join(env.TPS_MAIL_DIR, "..") : tmpdir(), "home");
  mkdirSync(home, { recursive: true });
  return spawnSync("bun", [TPS_BIN, "mail", "send", ...args], {
    encoding: "utf-8",
    cwd: tmpdir(),
    env: { ...process.env, HOME: home, ...env },
  });
}

function readSentEnvelope(mailDir: string, recipient: string): Envelope | null {
  const newDir = join(mailDir, recipient, "new");
  try {
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;
    const msg = JSON.parse(readFileSync(join(newDir, files[0]!), "utf-8"));
    return JSON.parse(msg.body) as Envelope;
  } catch {
    return null;
  }
}

// ─── Test fixtures ─────────────────────────────────────────────────────────

const FLINT_SEED = seedFromByte(0x01);
const SHERLOCK_SEED = seedFromByte(0x03);
const NATHAN_SEED = seedFromByte(0x05);
const RESEARCH_SEED = seedFromByte(0x04);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("tps mail send with signed envelopes", () => {
  let tempRoot: string;
  let keysDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-sign-send-"));
    keysDir = join(tempRoot, "keys");
    mkdirSync(keysDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // ── Test 1: No inbound chain ──────────────────────────────────────────

  test("signs envelope with fresh chain when TPS_INBOUND_CHAIN_JSON is unset", async () => {
    const mailDir = join(tempRoot, "mail");
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);

    const result = runMailSend(["anvil", "Build PR-3"], {
      TPS_MAIL_DIR: mailDir,
      TPS_AGENT_ID: "flint",
      TPS_TEST_KEYS_DIR: keysDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Message sent");

    const env = readSentEnvelope(mailDir, "anvil");
    expect(env).not.toBeNull();
    expect(env!.v).toBe(1);
    expect(env!.from).toBe("flint");
    expect(env!.to).toBe("anvil");
    expect(env!.body).toBe("Build PR-3");
    expect(env!.delegationChain.length).toBe(2);
    expect(env!.delegationChain[0].agent).toBe("system");
    expect(env!.delegationChain[0].kind).toBe("human");
    expect(env!.delegationChain[0].signature).toBeNull();
    expect(env!.delegationChain[1].agent).toBe("flint");
    expect(env!.delegationChain[1].kind).toBe("agent");
    expect(env!.delegationChain[1].signature).toMatch(/^ed25519:/);
    expect(env!.signature).toMatch(/^ed25519:/);

    // Verify
    const vr = await verifyEnvelope(env!, mockFlair({ flint: FLINT_SEED }));
    expect(vr).toEqual({ ok: true });
  });

  // ── Test 2: With inbound chain ────────────────────────────────────────

  test("appends to inbound chain and signs new hop", async () => {
    const mailDir = join(tempRoot, "mail");
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);
    writeFileSync(join(keysDir, "sherlock.key"), SHERLOCK_SEED);

    // Pre-sign a Flint envelope as the inbound chain
    const priorChain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T11:00:00.000Z", rationale: "Originates", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T11:05:00.000Z", rationale: "Dispatches", signature: null },
    ];
    const priorSigned = signEnvelope(
      { v: 1, from: "flint", to: "sherlock", body: "Review PR-1", messageId: "prior-001", timestamp: "2026-05-24T11:05:00.000Z", delegationChain: priorChain },
      { flint: FLINT_SEED },
    );
    const inboundChainJson = JSON.stringify(priorSigned.delegationChain);

    // Now send as sherlock with the inbound chain
    const result = runMailSend(["sherlock", "Forwarding to anvil"], {
      TPS_MAIL_DIR: mailDir,
      TPS_AGENT_ID: "sherlock",
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_INBOUND_CHAIN_JSON: inboundChainJson,
    });

    expect(result.status).toBe(0);

    const env = readSentEnvelope(mailDir, "sherlock");
    expect(env).not.toBeNull();
    // Chain should have 3 entries: nathan, flint, sherlock
    expect(env!.delegationChain.length).toBe(3);
    expect(env!.delegationChain[0].agent).toBe("nathan");
    expect(env!.delegationChain[1].agent).toBe("flint");
    expect(env!.delegationChain[2].agent).toBe("sherlock");
    expect(env!.from).toBe("sherlock");

    // Flint's prior sig should be preserved
    expect(env!.delegationChain[1].signature).toBe(priorSigned.delegationChain[1].signature);

    // All sigs verify
    const vr = await verifyEnvelope(env!, mockFlair({ flint: FLINT_SEED, sherlock: SHERLOCK_SEED }));
    expect(vr).toEqual({ ok: true });
  });

  // ── Test 3: Custom rationale ──────────────────────────────────────────

  // ── Test 4: 4-hop chain end-to-end (PR-5) ───────────────────────────

  test("builds and verifies a 4-hop chain nathan→flint→sherlock→research-agent", async () => {
    const mailDir = join(tempRoot, "mail");
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);
    writeFileSync(join(keysDir, "sherlock.key"), SHERLOCK_SEED);
    writeFileSync(join(keysDir, "research-agent.key"), RESEARCH_SEED);

    // ── Hop 1: nathan (human) → flint (agent) ──
    // Build a 2-entry chain: nathan originates, flint signs and delivers.
    const hop1Chain: ChainEntry[] = [
      { agent: "nathan", kind: "human", timestamp: "2026-05-24T12:00:00.000Z", rationale: "Originates request", signature: null },
      { agent: "flint", kind: "agent", timestamp: "2026-05-24T12:01:00.000Z", rationale: "Dispatches to sherlock", signature: null },
    ];
    const hop1Signed = signEnvelope(
      { v: 1, from: "flint", to: "sherlock", body: "Audit PR-1", messageId: "hop1-001", timestamp: "2026-05-24T12:01:00.000Z", delegationChain: hop1Chain },
      { flint: FLINT_SEED },
    );
    expect(hop1Signed.delegationChain.length).toBe(2);
    expect(hop1Signed.delegationChain[1].signature).toMatch(/^ed25519:/);

    const hop1ChainJson = JSON.stringify(hop1Signed.delegationChain);
    const hop1Vr = await verifyEnvelope(hop1Signed, mockFlair({ flint: FLINT_SEED }));
    expect(hop1Vr).toEqual({ ok: true });

    // ── Hop 2: sherlock receives via TPS_INBOUND_CHAIN_JSON, forwards ──
    const hop2Result = runMailSend(
      ["research-agent", "Review complete"],
      {
        TPS_MAIL_DIR: mailDir,
        TPS_AGENT_ID: "sherlock",
        TPS_TEST_KEYS_DIR: keysDir,
        TPS_INBOUND_CHAIN_JSON: hop1ChainJson,
        TPS_CHAIN_RATIONALE: "K&S review of hop1",
      },
    );
    expect(hop2Result.status).toBe(0);

    const hop2Env = readSentEnvelope(mailDir, "research-agent");
    expect(hop2Env).not.toBeNull();
    // Chain should now have 3 entries: nathan, flint, sherlock
    expect(hop2Env!.delegationChain.length).toBe(3);
    expect(hop2Env!.delegationChain[0].agent).toBe("nathan");
    expect(hop2Env!.delegationChain[0].kind).toBe("human");
    expect(hop2Env!.delegationChain[0].signature).toBeNull();
    expect(hop2Env!.delegationChain[1].agent).toBe("flint");
    expect(hop2Env!.delegationChain[1].kind).toBe("agent");
    expect(hop2Env!.delegationChain[2].agent).toBe("sherlock");
    expect(hop2Env!.delegationChain[2].kind).toBe("agent");
    expect(hop2Env!.delegationChain[2].rationale).toBe("K&S review of hop1");
    // Flint's prior sig must be preserved across the chain
    expect(hop2Env!.delegationChain[1].signature).toBe(hop1Signed.delegationChain[1].signature);

    const hop2Vr = await verifyEnvelope(hop2Env!, mockFlair({ flint: FLINT_SEED, sherlock: SHERLOCK_SEED }));
    expect(hop2Vr).toEqual({ ok: true });

    // ── Hop 3: research-agent receives via TPS_INBOUND_CHAIN_JSON, forwards ──
    const hop2ChainJson = JSON.stringify(hop2Env!.delegationChain);
    const hop3Result = runMailSend(
      ["archive", "Report delivered"],
      {
        TPS_MAIL_DIR: mailDir,
        TPS_AGENT_ID: "research-agent",
        TPS_TEST_KEYS_DIR: keysDir,
        TPS_INBOUND_CHAIN_JSON: hop2ChainJson,
        TPS_CHAIN_RATIONALE: "research findings",
      },
    );
    expect(hop3Result.status).toBe(0);

    const hop3Env = readSentEnvelope(mailDir, "archive");
    expect(hop3Env).not.toBeNull();

    // ── Verify the 4-hop chain ──
    expect(hop3Env!.delegationChain.length).toBe(4);
    // Entry 0: nathan (human, origin)
    expect(hop3Env!.delegationChain[0].agent).toBe("nathan");
    expect(hop3Env!.delegationChain[0].kind).toBe("human");
    expect(hop3Env!.delegationChain[0].signature).toBeNull();
    // Entry 1: flint (agent, first signer)
    expect(hop3Env!.delegationChain[1].agent).toBe("flint");
    expect(hop3Env!.delegationChain[1].kind).toBe("agent");
    expect(hop3Env!.delegationChain[1].signature).toMatch(/^ed25519:/);
    expect(hop3Env!.delegationChain[1].signature).toBe(hop1Signed.delegationChain[1].signature);
    // Entry 2: sherlock (agent, reviewer — at index 2, not 3)
    expect(hop3Env!.delegationChain[2].agent).toBe("sherlock");
    expect(hop3Env!.delegationChain[2].kind).toBe("agent");
    expect(hop3Env!.delegationChain[2].signature).toMatch(/^ed25519:/);
    expect(hop3Env!.delegationChain[2].signature).toBe(hop2Env!.delegationChain[2].signature);
    // Entry 3: research-agent (agent, final forwarder)
    expect(hop3Env!.delegationChain[3].agent).toBe("research-agent");
    expect(hop3Env!.delegationChain[3].kind).toBe("agent");
    expect(hop3Env!.delegationChain[3].signature).toMatch(/^ed25519:/);
    expect(hop3Env!.delegationChain[3].rationale).toBe("research findings");
    // Outer envelope from
    expect(hop3Env!.from).toBe("research-agent");
    expect(hop3Env!.to).toBe("archive");

    // All 4 entries have valid signatures (human entry has null)
    const hop3Vr = await verifyEnvelope(
      hop3Env!,
      mockFlair({ flint: FLINT_SEED, sherlock: SHERLOCK_SEED, "research-agent": RESEARCH_SEED }),
    );
    expect(hop3Vr).toEqual({ ok: true });
  });

  // ── Test 3: Custom rationale ──────────────────────────────────────────

  // ── Test 5: Branch-office route also ships signed body (gap #1) ────────

  test("branch-office route writes a signed envelope (not raw body)", async () => {
    // Repro of the rollout gap: pre-PR, the branch-office bridge path
    // (`tps mail send` → ~/.tps/branch-office/<to>/mail/...) returned BEFORE
    // the signing block ran, so K&S/branch-office dispatches shipped unsigned.
    // After the lift, this route ships a signed envelope JSON as body.
    const home = join(tempRoot, "home");
    const branchInbox = join(home, ".tps", "branch-office", "anvil", "mail", "inbox");
    mkdirSync(branchInbox, { recursive: true });
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);

    const result = runMailSend(["anvil", "Dispatch via branch-office"], {
      HOME: home,
      TPS_AGENT_ID: "flint",
      TPS_TEST_KEYS_DIR: keysDir,
    });

    expect(result.status).toBe(0);

    // Branch-office delivery lands in <branch-office>/<to>/mail/new/<file>.json
    // (deliverToSandbox writes to mail/new/, not the inbox/ gate-dir).
    const deliveredDir = join(home, ".tps", "branch-office", "anvil", "mail", "new");
    const files = readdirSync(deliveredDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const wrapper = JSON.parse(readFileSync(join(deliveredDir, files[0]!), "utf-8"));
    // The wrapper.body is the signed envelope JSON string.
    const env = JSON.parse(wrapper.body) as Envelope;
    expect(env.v).toBe(1);
    expect(env.from).toBe("flint");
    expect(env.to).toBe("anvil");
    expect(env.body).toBe("Dispatch via branch-office");
    expect(env.delegationChain.length).toBe(2);
    expect(env.delegationChain[1].signature).toMatch(/^ed25519:/);
    expect(env.signature).toMatch(/^ed25519:/);

    const vr = await verifyEnvelope(env, mockFlair({ flint: FLINT_SEED }));
    expect(vr).toEqual({ ok: true });
  });

  test("uses TPS_CHAIN_RATIONALE in the current hop entry", async () => {
    const mailDir = join(tempRoot, "mail");
    writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);

    const result = runMailSend(["anvil", "With rationale"], {
      TPS_MAIL_DIR: mailDir,
      TPS_AGENT_ID: "flint",
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_CHAIN_RATIONALE: "K&S dispatch on bob#42",
    });

    expect(result.status).toBe(0);

    const env = readSentEnvelope(mailDir, "anvil");
    expect(env).not.toBeNull();
    expect(env!.delegationChain[1].rationale).toBe("K&S dispatch on bob#42");
    expect(env!.delegationChain[1].signature).toMatch(/^ed25519:/);

    const vr = await verifyEnvelope(env!, mockFlair({ flint: FLINT_SEED }));
    expect(vr).toEqual({ ok: true });
  });
});
