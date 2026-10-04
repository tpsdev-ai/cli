import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { promote, redriveRetryable, RETRYABLE_REJECT_CLASSES } from "../src/utils/mail.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const SENDER = "agent-a";
const MAILBOX = "agent-b";
const READER_SEED = Buffer.alloc(32, 0x22);
const SENDER_SEED = Buffer.alloc(32, 0x33);
const SENDER_PUB = Buffer.from(ed.getPublicKey(new Uint8Array(SENDER_SEED)));

let home: string;
let flairKeyPath: string;
let fetchSpy: ReturnType<typeof spyOn>;
let savedEnv: Record<string, string | undefined>;
/** What the stub hub serves as the sender's publicKey. */
let servedKey: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mail-pending-key-"));
  const keys = join(home, "keys");
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
  fetchSpy.mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://flair.test");
    if (url.pathname === "/Health") return new Response("ok");
    expect(url.pathname).toBe(`/Agent/${SENDER}`);
    return Response.json({ id: SENDER, name: SENDER, publicKey: servedKey });
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function plantSigned(): { inbox: string; file: string } {
  const now = new Date().toISOString();
  const envelope: Envelope = signEnvelope(
    {
      v: 1,
      from: SENDER,
      to: MAILBOX,
      body: "hello",
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      delegationChain: [
        { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
        { agent: SENDER, kind: "agent", timestamp: now, rationale: `agent ${SENDER} sends`, signature: null },
      ],
    },
    { [SENDER]: SENDER_SEED },
  );
  const inbox = join(home, "mail", MAILBOX);
  mkdirSync(join(inbox, "new"), { recursive: true });
  const file = join(inbox, "new", "message.json");
  writeFileSync(file, JSON.stringify({ id: envelope.messageId, from: SENDER, to: MAILBOX, body: JSON.stringify(envelope) }));
  return { inbox, file };
}

const verify = () => ({ flairUrl: "http://flair.test", flairKeyPath });
const jsonFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json"));

test("mail from a sender whose key is still pending is retried, and one redrive delivers it once the key is registered", async () => {
  const { inbox, file } = plantSigned();
  servedKey = "pending";

  const first = await promote(MAILBOX, file, verify());
  expect(first.ok).toBe(false);
  if (first.ok) throw new Error("unexpected promotion");
  expect(first.class).toBe("verify-unavailable");
  expect(RETRYABLE_REJECT_CLASSES.has(first.class)).toBe(true);
  const reason = readFileSync(join(inbox, "dlq", "message.json.reason"), "utf8");
  expect(reason).toContain("class: verify-unavailable");
  expect(reason).toContain(`no registered public key for ${SENDER} yet (pending)`);

  servedKey = SENDER_PUB.toString("hex");
  const redriven = await redriveRetryable(MAILBOX, join(inbox, "dlq"), verify());
  expect(redriven).toHaveLength(1);
  expect(redriven[0]?.message.body).toBe("hello");
  expect(await redriveRetryable(MAILBOX, join(inbox, "dlq"), verify())).toHaveLength(0);
  expect(jsonFiles(join(inbox, "cur"))).toHaveLength(1);
  expect(readdirSync(join(inbox, "new"))).toEqual([]);
  expect(readdirSync(join(inbox, "dlq"))).toEqual([]);
});

for (const key of ["not-a-key!!", "PENDING", " pending", "pending="]) {
  test(`a malformed key other than the exact pending sentinel (${JSON.stringify(key)}) stays terminal`, async () => {
    const { inbox, file } = plantSigned();
    servedKey = key;

    const first = await promote(MAILBOX, file, verify());
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("unexpected promotion");
    expect(first.class).toBe("invalid");
    expect(RETRYABLE_REJECT_CLASSES.has(first.class)).toBe(false);
    expect(readFileSync(join(inbox, "dlq", "message.json.reason"), "utf8")).toContain(
      `malformed public key for ${SENDER}`,
    );

    servedKey = SENDER_PUB.toString("hex");
    expect(await redriveRetryable(MAILBOX, join(inbox, "dlq"), verify())).toHaveLength(0);
    expect(jsonFiles(join(inbox, "dlq"))).toEqual(["message.json"]);
  });
}
