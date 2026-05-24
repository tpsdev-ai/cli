/**
 * mail-consumer-verify.test.ts — PR-4: consumer strict verification
 *
 * Tests checkMessages() with a FlairClient to verify signed envelopes
 * before new/ → cur/ promotion. On failure, messages go to dlq/ with
 * .reject sidecar.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { signEnvelope, type Envelope, verifyEnvelope } from "../src/lib/signEnvelope.js";
import { sendMessage, checkMessages, getInbox } from "../src/utils/mail.js";

// Wire sha512 for sync sign operations.
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

// ─── Fixture Keys ──────────────────────────────────────────────────────────

const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

const FLINT_PUBKEY = pubkeyFromSeed(FLINT_SEED);
const KERN_PUBKEY = pubkeyFromSeed(KERN_SEED);

// ─── Mock FlairClient ──────────────────────────────────────────────────────

/** Returns a FlairClient that knows about our fixture agents. */
function mockFlairClient(): { getAgent(name: string): Promise<{ publicKey: Buffer } | null> } {
  return {
    getAgent: async (name: string) => {
      if (name === "flint") return { publicKey: FLINT_PUBKEY };
      if (name === "kern") return { publicKey: KERN_PUBKEY };
      return null;
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildSignedEnvelope(from: string, to: string, body: string): Envelope {
  const env: Envelope = {
    v: 1,
    from,
    to,
    subject: `Test from ${from}`,
    body,
    messageId: `msg-${Date.now()}`,
    timestamp: new Date().toISOString(),
    delegationChain: [
      {
        agent: "system",
        kind: "human" as const,
        timestamp: new Date().toISOString(),
        rationale: "test",
        signature: null,
      },
      {
        agent: from,
        kind: "agent" as const,
        timestamp: new Date().toISOString(),
        rationale: `agent ${from} test send`,
        signature: null,
      },
    ],
  };

  const keysByAgent: Record<string, Buffer> = {};
  keysByAgent[from] = from === "flint" ? FLINT_SEED : KERN_SEED;
  return signEnvelope(env, keysByAgent);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("mail consumer verification (PR-4)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-test-mail-verify-"));
    mkdirSync(join(tempRoot, "keys"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeEnv() {
    return {
      TPS_TEST_KEYS_DIR: join(tempRoot, "keys"),
      TPS_MAIL_DIR: join(tempRoot, "mail"),
    };
  }

  // ── Test 1: Valid signed envelope → promoted to cur/ ─────────────────────

  test("valid signed envelope is promoted to cur/", async () => {
    const env = makeEnv();
    process.env.TPS_MAIL_DIR = env.TPS_MAIL_DIR;

    // Build a signed envelope from flint to kern
    const signed = buildSignedEnvelope("flint", "kern", "this is a signed test message");
    const envelopeJson = JSON.stringify(signed);

    // Write it as a Maildir message in kern's new/
    sendMessage("kern", envelopeJson, "flint");

    const inbox = getInbox("kern");
    const newFiles = readdirSync(inbox.fresh).filter((f) => !f.startsWith("."));
    expect(newFiles.length).toBe(1);

    // Run consumer with verification
    const flair = mockFlairClient();
    const messages = await checkMessages("kern", "kern", flair);

    // Message was promoted to cur/
    expect(messages.length).toBe(1);
    expect(messages[0]!.from).toBe("flint");
    expect(messages[0]!.body).toBe(envelopeJson);

    // fresh/ is now empty
    expect(readdirSync(inbox.fresh).filter((f) => !f.startsWith(".")).length).toBe(0);

    // cur/ has the message
    expect(readdirSync(inbox.cur).filter((f) => !f.startsWith(".")).length).toBe(1);

    // dlq/ is empty (no rejection)
    expect(readdirSync(inbox.dlq).filter((f) => !f.startsWith(".") && !f.endsWith(".reject")).length).toBe(0);

    delete process.env.TPS_MAIL_DIR;
  });

  // ── Test 2: Unsigned envelope → dlq/ with sidecar ────────────────────────

  test("unsigned envelope (missing signature fields) is moved to dlq/", async () => {
    const env = makeEnv();
    process.env.TPS_MAIL_DIR = env.TPS_MAIL_DIR;

    // Write a JSON body that's an object but missing v1 envelope fields
    const fakeEnvelope = JSON.stringify({ foo: "bar", hello: "world" });
    sendMessage("kern", fakeEnvelope, "flint");

    const inbox = getInbox("kern");
    const newFiles = readdirSync(inbox.fresh).filter((f) => !f.startsWith("."));
    expect(newFiles.length).toBe(1);

    const flair = mockFlairClient();
    const messages = await checkMessages("kern", "kern", flair);

    // Nothing promoted to cur/
    expect(messages.length).toBe(0);

    // fresh/ is empty
    expect(readdirSync(inbox.fresh).filter((f) => !f.startsWith(".")).length).toBe(0);

    // cur/ is empty
    expect(readdirSync(inbox.cur).filter((f) => !f.startsWith(".")).length).toBe(0);

    // dlq/ has the message + sidecar
    const dlqFiles = readdirSync(inbox.dlq).filter((f) => !f.startsWith("."));
    expect(dlqFiles.length).toBeGreaterThanOrEqual(2); // message + .reject sidecar

    const rejectFiles = dlqFiles.filter((f) => f.endsWith(".reject"));
    expect(rejectFiles.length).toBe(1);

    delete process.env.TPS_MAIL_DIR;
  });

  // ── Test 3: Signed but tampered body → dlq/ with sidecar ─────────────────

  test("signed envelope with tampered body is moved to dlq/", async () => {
    const env = makeEnv();
    process.env.TPS_MAIL_DIR = env.TPS_MAIL_DIR;

    // Build a valid signed envelope
    const signed = buildSignedEnvelope("flint", "kern", "original body");
    // Tamper the body AFTER signing
    signed.body = "TAMPERED body!!!!";
    const tamperedJson = JSON.stringify(signed);

    sendMessage("kern", tamperedJson, "flint");

    const inbox = getInbox("kern");
    expect(readdirSync(inbox.fresh).filter((f) => !f.startsWith(".")).length).toBe(1);

    const flair = mockFlairClient();
    const messages = await checkMessages("kern", "kern", flair);

    // Nothing promoted
    expect(messages.length).toBe(0);
    expect(readdirSync(inbox.cur).filter((f) => !f.startsWith(".")).length).toBe(0);

    // dlq/ has message + sidecar
    const dlqFiles = readdirSync(inbox.dlq).filter((f) => !f.startsWith("."));
    const rejectFiles = dlqFiles.filter((f) => f.endsWith(".reject"));
    expect(rejectFiles.length).toBe(1);

    delete process.env.TPS_MAIL_DIR;
  });

  // ── Test 4: JSON parse error → dlq/ with sidecar ─────────────────────────

  test("malformed JSON body is moved to dlq/ without crashing", async () => {
    const env = makeEnv();
    process.env.TPS_MAIL_DIR = env.TPS_MAIL_DIR;

    // Write garbage that won't parse as JSON
    sendMessage("kern", "this is not json {{{ broken", "flint");

    const inbox = getInbox("kern");
    expect(readdirSync(inbox.fresh).filter((f) => !f.startsWith(".")).length).toBe(1);

    const flair = mockFlairClient();
    const messages = await checkMessages("kern", "kern", flair);

    // Nothing promoted
    expect(messages.length).toBe(0);
    expect(readdirSync(inbox.cur).filter((f) => !f.startsWith(".")).length).toBe(0);

    // dlq/ has message + sidecar
    const dlqFiles = readdirSync(inbox.dlq).filter((f) => !f.startsWith("."));
    const rejectFiles = dlqFiles.filter((f) => f.endsWith(".reject"));
    expect(rejectFiles.length).toBe(1);

    delete process.env.TPS_MAIL_DIR;
  });

  // ── Test 5 (bonus): .reject sidecar contains the reason ──────────────────

  test(".reject sidecar contains the rejection reason", async () => {
    const env = makeEnv();
    process.env.TPS_MAIL_DIR = env.TPS_MAIL_DIR;

    // Use a mock FlairClient that returns null for the sender's pubkey
    const flair = {
      getAgent: async (_name: string) => null,
    };

    // Signed envelope from flint — but our mock returns null for flint's pubkey
    const signed = buildSignedEnvelope("flint", "kern", "from flint");
    sendMessage("kern", JSON.stringify(signed), "flint");

    await checkMessages("kern", "kern", flair);

    const inbox = getInbox("kern");
    const dlqFiles = readdirSync(inbox.dlq).filter((f) => !f.startsWith("."));

    // Find the .reject sidecar
    const rejectFile = dlqFiles.find((f) => f.endsWith(".reject"));
    expect(rejectFile).toBeTruthy();

    // Read the sidecar content
    const { readFileSync } = await import("node:fs");
    const rejectContent = readFileSync(join(inbox.dlq, rejectFile!), "utf-8");
    expect(rejectContent.length).toBeGreaterThan(0);
    // The reason should be descriptive
    expect(rejectContent).toMatch(/agent|signature|invalid|pubkey|public key|not found/i);

    delete process.env.TPS_MAIL_DIR;
  });
});
