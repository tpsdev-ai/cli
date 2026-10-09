import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { patchShared } from "./helpers/patch-shared.js";
import { signEnvelope, verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { promote, RETRYABLE_REJECT_CLASSES } from "../src/utils/mail.js";
import { createMailVerifyClient } from "../src/utils/mail-verify.js";

afterEach(() => {
  mock.restore();
});

// Wire sha512 for the sync signing operations (same pattern as the other mail tests).
patchShared(hashes, "sha512", (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest()));

const SENDER = "flint";
const MAILBOX = "anvil";
const READER_SEED = Buffer.alloc(32, 0x22);

/** A 32-byte seed whose public key's base64url carries a '-' or '_'. */
function seedWithUrlChar(): Buffer {
  for (let i = 0; i < 256; i++) {
    const candidate = Buffer.alloc(32, i);
    const encoded = Buffer.from(ed.getPublicKey(new Uint8Array(candidate))).toString("base64url");
    if (encoded.includes("-") || encoded.includes("_")) return candidate;
  }
  throw new Error("no single-byte seed produced a base64url key with '-' or '_'");
}

const SENDER_SEED = seedWithUrlChar();
const SENDER_PUB = Buffer.from(ed.getPublicKey(new Uint8Array(SENDER_SEED)));

let home: string;
let keys: string;
let flairKeyPath: string;
let fetchSpy: ReturnType<typeof spyOn>;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mail-verify-key-"));
  keys = join(home, "keys");
  mkdirSync(keys);
  savedEnv = {};
  for (const name of ["HOME", "TPS_HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR"]) {
    savedEnv[name] = process.env[name];
  }
  process.env.HOME = home;
  process.env.TPS_HOME = join(home, ".tps");
  process.env.TPS_MAIL_DIR = join(home, "mail");
  process.env.TPS_TEST_KEYS_DIR = keys;
  flairKeyPath = join(keys, "reader.key");
  writeFileSync(flairKeyPath, READER_SEED);
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Stub the hub: `/Agent/<name>` returns `publicKeyFor(name)`, /Health is up. */
function stubHub(publicKeyFor: (name: string) => string | null): void {
  fetchSpy.mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://flair.test");
    if (url.pathname === "/Health") return new Response("ok");
    const name = url.pathname.match(/^\/Agent\/(.+)$/)?.[1];
    const key = name ? publicKeyFor(decodeURIComponent(name)) : null;
    return key !== null
      ? Response.json({ id: name, name, publicKey: key })
      : new Response("not found", { status: 404 });
  });
}

function signedEnvelope(from: string, to: string, body: string, seed: Buffer): Envelope {
  const now = new Date().toISOString();
  return signEnvelope(
    {
      v: 1,
      from,
      to,
      body,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      delegationChain: [
        { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
        { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} sends`, signature: null },
      ],
    },
    { [from]: seed },
  );
}

async function verifyAgainst(publicKey: string, envelope: Envelope) {
  stubHub((name) => (name === SENDER ? publicKey : null));
  const client = await createMailVerifyClient(MAILBOX, {
    flairUrl: "http://flair.test",
    flairKeyPath,
  });
  return verifyEnvelope(envelope, client);
}

test("an unpadded base64url hub key (43 chars, with '-' or '_') verifies a signed envelope", async () => {
  const encoded = SENDER_PUB.toString("base64url");
  expect(encoded).toHaveLength(43);
  expect(encoded).toMatch(/[-_]/);
  const result = await verifyAgainst(encoded, signedEnvelope(SENDER, MAILBOX, "hello", SENDER_SEED));
  expect(result).toEqual({ ok: true });
});

test("the same key in standard padded base64 verifies", async () => {
  const encoded = SENDER_PUB.toString("base64");
  expect(encoded).toMatch(/=$/);
  const result = await verifyAgainst(encoded, signedEnvelope(SENDER, MAILBOX, "hello", SENDER_SEED));
  expect(result).toEqual({ ok: true });
});

test("standard unpadded base64 verifies", async () => {
  const encoded = SENDER_PUB.toString("base64").replace(/=+$/, "");
  const result = await verifyAgainst(encoded, signedEnvelope(SENDER, MAILBOX, "hello", SENDER_SEED));
  expect(result).toEqual({ ok: true });
});

for (const [label, key] of [
  ["31 bytes", Buffer.alloc(31, 0x01).toString("base64url")],
  ["33 bytes", Buffer.alloc(33, 0x01).toString("base64url")],
  ["invalid characters", "not-a-key!!"],
  ["empty", ""],
  ["overpadding", SENDER_PUB.toString("base64") + "="],
] as const) {
  test(`a malformed hub key (${label}) refuses with the existing error`, async () => {
    stubHub(() => key);
    const client = await createMailVerifyClient(MAILBOX, {
      flairUrl: "http://flair.test",
      flairKeyPath,
    });
    await expect(client.getAgent(SENDER)).rejects.toThrow(
      `Flair returned a malformed public key for ${SENDER}`,
    );
  });
}

for (const encoding of ["hex", "base64url", "base64"] as const) {
  test(`${encoding} stored key verifies`, async () => {
    expect(await verifyAgainst(SENDER_PUB.toString(encoding),
      signedEnvelope(SENDER, MAILBOX, "hello", SENDER_SEED))).toEqual({ ok: true });
  });
}

for (const failure of ["malformed", "unreachable"] as const) {
  test(`promote keeps a ${failure} Flair key failure in its proper rejection class`, async () => {
    if (failure === "malformed") stubHub(() => "not-a-key!!");
    else fetchSpy.mockImplementation(async () => { throw new Error("Flair unreachable"); });
    const inbox = join(home, "mail", MAILBOX);
    const fresh = join(inbox, "new");
    mkdirSync(fresh, { recursive: true });
    const file = join(fresh, "message.json");
    const envelope = signedEnvelope(SENDER, MAILBOX, "hello", SENDER_SEED);
    writeFileSync(file, JSON.stringify({ id: envelope.messageId, from: SENDER, to: MAILBOX, body: JSON.stringify(envelope) }));
    const result = await promote(MAILBOX, file, { flairUrl: "http://flair.test", flairKeyPath });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected promotion");
    expect(result.class).toBe(failure === "malformed" ? "invalid" : "verify-unavailable");
    expect(RETRYABLE_REJECT_CLASSES.has(result.class)).toBe(failure === "unreachable");
    expect(readdirSync(fresh)).toEqual([]);
    const reason = readFileSync(join(inbox, "dlq", "message.json.reason"), "utf8");
    expect(reason).toContain(`class: ${result.class}`);
    expect(reason).toContain(failure === "malformed" ? "malformed public key for flint" : "Flair unreachable");
  });
}
