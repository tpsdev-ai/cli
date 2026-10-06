import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { MailClient } from "../src/io/mail.js";
import { acquireMailLockSync } from "../src/lib/mail-lock.js";
import { mailboxReplayStore } from "../src/lib/mailbox-policy.js";
import { signEnvelope } from "../src/lib/signEnvelope.js";

let root: string;
let client: MailClient;
let messageId: string;
const seed = Buffer.alloc(32, 1);
const path = (dir: string) => join(root, "mailbox", dir, "m1.json");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "placement-replay-"));
  client = new MailClient(root, undefined, "mailbox", {
    async getAgent() { return { publicKey: Buffer.from(ed.getPublicKey(seed)) }; },
  });
  const timestamp = new Date().toISOString();
  messageId = "placement-replay";
  const envelope = signEnvelope({
    v: 1, from: "flint", to: "mailbox", body: "hello", messageId, timestamp,
    delegationChain: [
      { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
      { agent: "flint", kind: "agent", timestamp, rationale: "sends", signature: null },
    ],
  }, { flint: seed });
  writeFileSync(path("new"), JSON.stringify({ from: "flint", body: JSON.stringify(envelope) }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pruneConsumedId(): void {
  const mailbox = join(root, "mailbox");
  const ledger = join(mailbox, "consumed.jsonl");
  writeFileSync(ledger, JSON.stringify({ id: messageId, at: "2000-01-01T00:00:00.000Z" }) + "\n");
  const lock = acquireMailLockSync(mailbox);
  if (!lock) throw new Error("lock unavailable");
  try { expect(mailboxReplayStore(mailbox).isConsumed("absent-id")).toBe(false); }
  finally { lock.release(); }
  expect(readFileSync(ledger, "utf8")).toBe("");
}

test("a delivered file hard-linked back into new/ is removed without delivery", async () => {
  expect(await client.checkNewMail()).toHaveLength(1);
  linkSync(path("cur"), path("new"));
  expect(await client.checkNewMail()).toEqual([]);
  expect(() => readFileSync(path("new"))).toThrow();
  expect(await client.checkNewMail()).toEqual([]);
});

test("a delivered file relink is removed after its consumed ID is pruned", async () => {
  expect(await client.checkNewMail()).toHaveLength(1);
  pruneConsumedId();
  linkSync(path("cur"), path("new"));
  expect(await client.checkNewMail()).toEqual([]);
  expect(() => readFileSync(path("new"))).toThrow();
  expect(await client.checkNewMail()).toEqual([]);
});


function pendingPlacement(id = messageId): void {
  const mailbox = join(root, "mailbox");
  const lock = acquireMailLockSync(mailbox);
  if (!lock) throw new Error("lock unavailable");
  try { mailboxReplayStore(mailbox).beginPlacement(id, "m1.json"); }
  finally { lock.release(); }
  linkSync(path("new"), path("cur"));
}

test("a placement interrupted after linking is recovered by a restarted client", async () => {
  const link = fs.linkSync;
  const fault = spyOn(fs, "linkSync").mockImplementation((...args: Parameters<typeof link>) => {
    link(...args);
    throw new Error("interrupted after link");
  });
  try { expect(await client.checkNewMail()).toEqual([]); }
  finally { fault.mockRestore(); }
  const mailbox = join(root, "mailbox");
  const lock = acquireMailLockSync(mailbox);
  if (!lock) throw new Error("lock unavailable");
  try { expect(mailboxReplayStore(mailbox).hasPendingPlacement(messageId, "m1.json")).toBe(true); }
  finally { lock.release(); }
  const restarted = new MailClient(root, undefined, "mailbox", {
    async getAgent() { return { publicKey: Buffer.from(ed.getPublicKey(seed)) }; },
  });
  expect(await restarted.checkNewMail()).toHaveLength(1);
  expect(await restarted.checkNewMail()).toEqual([]);
  const finishedLock = acquireMailLockSync(mailbox);
  if (!finishedLock) throw new Error("lock unavailable");
  try { expect(mailboxReplayStore(mailbox).hasPendingPlacement(messageId, "m1.json")).toBe(false); }
  finally { finishedLock.release(); }
  pruneConsumedId();
  linkSync(path("cur"), path("new"));
  expect(await restarted.checkNewMail()).toEqual([]);
  expect(() => readFileSync(path("new"))).toThrow();
});

test("an intent for another ID does not authorize delivery", async () => {
  pendingPlacement("other-id");
  expect(await client.checkNewMail()).toEqual([]);
  expect(() => readFileSync(path("new"))).toThrow();
});

for (const pending of [false, true]) {
  test(`a linked record with corrupt history is withheld (pending=${pending})`, async () => {
    if (pending) pendingPlacement();
    else linkSync(path("new"), path("cur"));
    writeFileSync(join(root, "mailbox", "consumed.jsonl"), "broken history\n");
    expect(await client.checkNewMail()).toEqual([]);
    expect(readFileSync(path("new"))).toEqual(readFileSync(path("cur")));
  });
}

test("pending recovery validates other maildir history", async () => {
  pendingPlacement();
  writeFileSync(join(root, "mailbox", "cur", "corrupt.json"), "broken history");
  expect(await client.checkNewMail()).toEqual([]);
  expect(readFileSync(path("new"))).toEqual(readFileSync(path("cur")));
});
