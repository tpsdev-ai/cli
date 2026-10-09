import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommittedMessageId } from "@tpsdev-ai/agent";
import { FlairClient } from "../src/utils/flair-client.js";
import { checkMessages, getInbox } from "../src/utils/mail.js";
import { buildSignedEnvelope, pubkeyFromSeed, stubFlairHandler, writeKeyFile } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const receiver = "auth-receiver";
const sender = "auth-sender";
const seed = Buffer.alloc(32, 0x31);
const wrongSeed = Buffer.alloc(32, 0x32);
let root: string;
const fetchMockState = { value: undefined as unknown as ReturnType<typeof spyOn> | undefined };
let savedMailDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-auth-"));
  savedMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = join(root, "mail");
});

afterEach(() => {
  fetchMockState.value?.mockRestore();
  patchShared(fetchMockState, "value", undefined);
  if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = savedMailDir;
  rmSync(root, { recursive: true, force: true });
});

function intercept() {
  const handler = stubFlairHandler({ [receiver]: seed, [sender]: seed });
  patchShared(fetchMockState, "value", spyOn(globalThis, "fetch").mockImplementation((async (input, init) =>
    handler(new Request(input, init))) as typeof fetch));
  return handler;
}

function client(agentId: string, keySeed: Buffer, baseUrl = "http://flair.test") {
  const keyPath = writeKeyFile(root, agentId, keySeed);
  return new FlairClient({ agentId, keyPath, baseUrl });
}

test("Flair stub refuses missing caller credentials", async () => {
  const response = intercept()(new Request(`http://flair.test/Agent/${sender}`));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ type: "error:AccessViolation", code: "AccessViolation", status: 403 });
});

for (const caller of ["invalid", "unknown"] as const) {
  test(`Flair stub refuses ${caller} signed caller credentials`, async () => {
    intercept();
    const reader = client(caller === "unknown" ? "unknown-caller" : receiver, wrongSeed);
    await expect(reader.getAgentForVerification(sender)).rejects.toThrow(
      caller === "unknown" ? '401: {"error":"unknown_agent"}' : '401: {"error":"invalid_signature"}',
    );
  });
}

test("Flair stub accepts the real client's signed Agent read", async () => {
  intercept();
  expect((await client(receiver, seed).getAgentForVerification(sender))?.publicKey).toBe(pubkeyFromSeed(seed).toString("base64"));
});

async function refusedReadRecovery(baseUrl: string, to: string, from: string) {
  const keyPath = writeKeyFile(root, to, wrongSeed);
  const inbox = getInbox(to);
  const envelope = buildSignedEnvelope(from, to, "auth recovery", { [from]: seed }, { messageId: randomUUID() });
  const source = join(inbox.fresh, "record.json");
  writeFileSync(source, JSON.stringify({ id: envelope.messageId, from, to, body: JSON.stringify(envelope), timestamp: envelope.timestamp }));
  const config = { flairUrl: baseUrl, flairKeyPath: keyPath };
  expect(await checkMessages(to, to, config)).toEqual([]);
  expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
  expect(JSON.parse(readFileSync(join(inbox.dlq, "record.json"), "utf8")).body).toBe(JSON.stringify(envelope));
  expect(readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("verify-unavailable");
  writeKeyFile(root, to, seed);
  expect((await checkMessages(to, to, config)).map((message) => message.body)).toEqual(["auth recovery"]);
  expect(await checkMessages(to, to, config)).toEqual([]);
}

test("a refused Agent read leaves mail undelivered and recoverable", async () => {
  intercept();
  await refusedReadRecovery("http://flair.test", receiver, sender);
});

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("real Flair Agent read guards and refused-read mail recovery", async () => {
  const baseUrl = "http://127.0.0.1:9926";
  const opsUrl = "http://127.0.0.1:9925";
  const to = `auth-receiver-${randomUUID()}`;
  const from = `auth-sender-${randomUUID()}`;
  const admin = `Basic ${Buffer.from("admin:test123").toString("base64")}`;
  const operation = (body: unknown) => fetch(opsUrl, {
    method: "POST", headers: { Authorization: admin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const inserted = await operation({ operation: "insert", database: "flair", table: "Agent", records: [to, from].map((id) => ({
    id, name: id, publicKey: pubkeyFromSeed(seed).toString("base64"), createdAt: new Date().toISOString(),
  })) });
  expect(inserted.ok).toBe(true);
  try {
    const anonymous = await fetch(`${baseUrl}/Agent/${from}`);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ type: "error:AccessViolation", code: "AccessViolation", status: 403 });
    await expect(client(to, wrongSeed, baseUrl).getAgentForVerification(from)).rejects.toThrow('401: {"error":"invalid_signature"}');
    await expect(client(`unknown-${randomUUID()}`, seed, baseUrl).getAgentForVerification(from)).rejects.toThrow('401: {"error":"unknown_agent"}');
    expect((await client(to, seed, baseUrl).getAgentForVerification(from))?.publicKey).toBe(pubkeyFromSeed(seed).toString("base64"));
    await refusedReadRecovery(baseUrl, to, from);
  } finally {
    const deleted = await operation({ operation: "delete", database: "flair", table: "Agent", ids: [to, from] });
    expect(deleted.ok).toBe(true);
  }
}, 30_000);
