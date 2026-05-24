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
