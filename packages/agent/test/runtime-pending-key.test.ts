import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope } from "../src/lib/signEnvelope.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import type { MailClient } from "../src/io/mail.js";
import { FlairContextProvider } from "../src/io/flair.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const SENDER = "agent-a";
const MAILBOX = "agent-b";
const SENDER_SEED = Buffer.alloc(32, 0x33);
const PUBLIC_KEY = Buffer.from(ed.getPublicKey(SENDER_SEED));
let root: string;
let fetchSpy: ReturnType<typeof spyOn>;
/** What the stub hub serves as the sender's publicKey. */
let servedKey: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-pending-key-"));
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
  rmSync(root, { recursive: true, force: true });
});

function setup(): { mail: MailClient; inbox: string } {
  const keyPath = join(root, "reader.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const runtime = new AgentRuntime({
    agentId: MAILBOX,
    name: MAILBOX,
    mailDir: join(root, "mail"),
    memoryPath: join(root, "memory.jsonl"),
    workspace: root,
    llm: { provider: "ollama", model: "stub" },
    flair: { url: "http://flair.test", keyPath },
  });
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope({
    v: 1,
    from: SENDER,
    to: MAILBOX,
    body: "verified delivery",
    messageId: "runtime-pending-key",
    timestamp,
    delegationChain: [
      { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
      { agent: SENDER, kind: "agent", timestamp, rationale: "sends", signature: null },
    ],
  }, { [SENDER]: SENDER_SEED });
  const inbox = join(root, "mail", MAILBOX);
  mkdirSync(join(inbox, "new"), { recursive: true });
  writeFileSync(join(inbox, "new", "message.json"), JSON.stringify({
    from: SENDER, to: MAILBOX, body: JSON.stringify(envelope),
  }));
  return { mail: (runtime as unknown as { mail: MailClient }).mail, inbox };
}

test("AgentRuntime keeps mail from a pending sender in new/ and promotes it once the key appears", async () => {
  const { mail, inbox } = setup();
  servedKey = "pending";
  expect(await mail.checkNewMail()).toEqual([]);
  expect(readdirSync(join(inbox, "new"))).toEqual(["message.json"]);
  expect(readdirSync(join(inbox, "cur"))).toEqual([]);
  expect(readdirSync(join(inbox, "dlq"))).toEqual([]);

  servedKey = PUBLIC_KEY.toString("hex");
  const messages = await mail.checkNewMail();
  expect(messages).toHaveLength(1);
  expect(messages[0]?.verifiedEnvelope?.body).toBe("verified delivery");
  expect(readdirSync(join(inbox, "new"))).toEqual([]);
  expect(readdirSync(join(inbox, "cur"))).toEqual(["message.json"]);
  expect(readdirSync(join(inbox, "dlq"))).toEqual([]);
});

test("AgentRuntime's verifier keeps the record in new/ when its provider returns a pending key", async () => {
  const getAgent = spyOn(FlairContextProvider.prototype, "getAgent")
    .mockResolvedValue({ id: SENDER, name: SENDER, publicKey: "pending" });
  try {
    const { mail, inbox } = setup();
    expect(await mail.checkNewMail()).toEqual([]);
    expect(getAgent).toHaveBeenCalled();
    expect(readdirSync(join(inbox, "new"))).toEqual(["message.json"]);
    expect(readdirSync(join(inbox, "dlq"))).toEqual([]);
  } finally {
    getAgent.mockRestore();
  }
});

for (const key of ["PENDING", " pending", "pending="]) {
  test(`AgentRuntime dead-letters a near-miss of the pending sentinel (${JSON.stringify(key)}) as invalid`, async () => {
    const { mail, inbox } = setup();
    servedKey = key;
    expect(await mail.checkNewMail()).toEqual([]);
    expect(readdirSync(join(inbox, "new"))).toEqual([]);
    expect(readdirSync(join(inbox, "dlq")).sort()).toEqual(["message.json", "message.json.reason"]);
    const reason = readFileSync(join(inbox, "dlq", "message.json.reason"), "utf8");
    expect(reason).toContain("class: invalid");
    expect(reason).toContain(`malformed public key for ${SENDER}`);
  });
}
