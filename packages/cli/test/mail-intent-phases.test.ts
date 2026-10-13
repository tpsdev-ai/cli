/**
 * cli#617 slice (a): the CLI lease sweep and promotion keep any intent whose
 * declared phase is not `placing`. Nothing writes `in_progress` or `failed` yet,
 * so these fixtures write them directly over a committed placement.
 */
import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommittedMessageId, mailboxReplayStore } from "@tpsdev-ai/agent";
import * as mail from "../src/utils/mail.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const agent = "phase-test";
const seed = Buffer.alloc(32, 0x37);
let root: string;
let savedMailDir: string | undefined;
const verifierState = { value: undefined as unknown as ReturnType<typeof spyOn> };

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "intent-phases-"));
  savedMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  patchShared(verifierState, "value", spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({
    id: "kern", name: "kern", publicKey: pubkeyFromSeed(seed).toString("base64"),
  }));
});

afterEach(() => {
  verifierState.value.mockRestore();
  if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = savedMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const now = () => new Date().toISOString();
/** A file's text, or null when it is absent, so a removal fails an assertion rather than throwing. */
const textOf = (path: string) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null);
const IN_PROGRESS = { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: now() };
const FAILED = { version: 1, phase: "failed", presentations: 5, firstPresentedAt: now() };
const NOT_OURS: Record<string, Record<string, unknown>> = {
  in_progress: IN_PROGRESS,
  "an unknown phase": { version: 1, phase: "awaiting-review" },
  "a future schema version": { version: 2, phase: "placing" },
};

/**
 * A promoted record in cur/ whose ID is committed, with its source still in
 * new/ and its intent rewritten into the given phase.
 */
function committed(fields: Record<string, unknown>) {
  const inbox = mail.getInbox(agent);
  const envelope = buildSignedEnvelope("kern", agent, "hello", { kern: seed }, { messageId: "phase-delivery" });
  const record = { id: "record-id", from: "kern", to: agent, body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false };
  const source = join(inbox.fresh, "record.json");
  const cur = join(inbox.cur, "record.json");
  fs.writeFileSync(source, JSON.stringify(record));
  const scratch = join(inbox.tmp, "record.json.promote");
  fs.writeFileSync(scratch, JSON.stringify({
    ...record, body: envelope.body, envelopeId: envelope.messageId, envelope,
    checkedOutAt: now(), checkedOutBy: agent, deliveryAttempts: 1,
  }));
  const replay = mailboxReplayStore(inbox.root);
  replay.beginPlacement(envelope.messageId, "record.json", scratch);
  fs.linkSync(scratch, cur);
  replay.recordConsumed(envelope.messageId);
  const [name] = fs.readdirSync(inbox.root).filter((n) => n.startsWith(".placement-") && n.endsWith(".json"));
  const intent = join(inbox.root, name!);
  fs.writeFileSync(intent, JSON.stringify({ ...JSON.parse(fs.readFileSync(intent, "utf8")), ...fields }));
  const intentBytes = fs.readFileSync(intent, "utf8");
  const intentNow = () => textOf(intent);
  return { inbox, envelope, record, source, cur, intent, intentBytes, intentNow };
}

/** Expire the lease on the cur/ record so the lease sweep would re-present it. */
function expireLease(cur: string): string {
  const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
  copy.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(cur, JSON.stringify(copy));
  return fs.readFileSync(cur, "utf8");
}

function plantUnrelated(inbox: ReturnType<typeof mail.getInbox>) {
  const other = buildSignedEnvelope("kern", agent, "unrelated", { kern: seed }, { messageId: "unrelated-id" });
  fs.writeFileSync(join(inbox.fresh, "unrelated.json"), JSON.stringify({
    id: "unrelated-record", from: "kern", to: agent, body: JSON.stringify(other), timestamp: other.timestamp,
  }));
}

describe("CLI lease sweep withholds a record whose intent is not placing (utils/mail.ts checkMessages)", () => {
  for (const [name, fields] of Object.entries({ ...NOT_OURS, failed: FAILED })) {
    test(`${name}: not presented, checked out or finished; other mail flows`, async () => {
      const f = committed(fields);
      fs.rmSync(f.source);
      const before = expireLease(f.cur);
      plantUnrelated(f.inbox);

      expect((await mail.checkMessages(agent)).map((m) => m.body)).toEqual(["unrelated"]);
      expect(await mail.checkMessages(agent)).toEqual([]);

      expect(textOf(f.cur)).toBe(before);
      expect(f.intentNow()).toBe(f.intentBytes);
      expect(fs.existsSync(`${f.intent}.quarantined`)).toBe(false);
      expect(fs.existsSync(join(f.inbox.dlq, "record.json"))).toBe(false);
    });
  }
});

describe("CLI promote leaves a same-message in_progress, unknown-phase or future-version intent as it is, and refuses a failed one's duplicate as replay (utils/mail.ts promote)", () => {
  for (const [name, fields] of Object.entries(NOT_OURS)) {
    test(`${name}: busy, with the source, cur copy and intent untouched`, async () => {
      const f = committed(fields);
      const curBefore = fs.readFileSync(f.cur, "utf8");
      const sourceBefore = fs.readFileSync(f.source, "utf8");

      const result = await mail.promote(agent, f.source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.class).toBe("busy");
      expect(await mail.checkMessages(agent)).toEqual([]);

      expect(textOf(f.source)).toBe(sourceBefore);
      expect(textOf(f.cur)).toBe(curBefore);
      expect(f.intentNow()).toBe(f.intentBytes);
      expect(fs.existsSync(join(f.inbox.dlq, "record.json"))).toBe(false);
    });
  }

  test("failed: a same-name duplicate is refused as replay; the failed intent and payload are kept", async () => {
    const f = committed(FAILED);
    const curBefore = fs.readFileSync(f.cur, "utf8");

    const result = await mail.promote(agent, f.source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.class).toBe("replay");

    expect(fs.existsSync(f.source)).toBe(false);
    expect(textOf(join(f.inbox.dlq, "record.json.reason")) ?? "").toContain("class: replay");
    expect(textOf(f.cur)).toBe(curBefore);
    expect(f.intentNow()).toBe(f.intentBytes);
    expect(hasCommittedMessageId(f.inbox.root, f.envelope.messageId)).toBe(true);
  });
});

describe("retention: a failed intent is kept; its payload follows ordinary cur/ retention", () => {
  for (const [name, fields, archived] of [["failed", FAILED, 1], ["in_progress", IN_PROGRESS, 0]] as const) {
    test(`${name}: archiveOldCur moves ${archived} aged payload(s) and keeps the intent`, () => {
      const f = committed(fields);
      fs.rmSync(f.source);
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(f.cur, old, old);

      expect(mail.archiveOldCur(agent)).toBe(archived);
      expect(fs.existsSync(f.cur)).toBe(archived === 0);
      expect(f.intentNow()).toBe(f.intentBytes);
    });
  }

  test("failed: once archiveOldCur archives the payload and the tombstone name is unoccupied, a different message at the same name is delivered and the marker moves to that tombstone", async () => {
    const f = committed(FAILED);
    fs.rmSync(f.source);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(f.cur, old, old);
    expect(mail.archiveOldCur(agent)).toBe(1);
    const other = buildSignedEnvelope("kern", agent, "reused", { kern: seed }, { messageId: "reused-name-id" });
    fs.writeFileSync(f.source, JSON.stringify({
      id: "reused-record", from: "kern", to: agent, body: JSON.stringify(other), timestamp: other.timestamp,
    }));

    expect((await mail.checkMessages(agent)).map((m) => m.body)).toEqual(["reused"]);

    expect(fs.existsSync(f.source)).toBe(false);
    expect(textOf(f.intent.replace(/\.json$/, `.failed-${f.envelope.messageId}.json`))).toBe(f.intentBytes);
    expect(f.intentNow()).toBeNull();
    expect(hasCommittedMessageId(f.inbox.root, f.envelope.messageId)).toBe(true);
    expect(hasCommittedMessageId(f.inbox.root, "reused-name-id")).toBe(true);
  });

  test("failed: an occupied tombstone refuses the reuse by name; marker and tombstone stay byte-identical, nothing is presented", async () => {
    const f = committed(FAILED);
    fs.rmSync(f.source);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(f.cur, old, old);
    expect(mail.archiveOldCur(agent)).toBe(1);
    const tombstone = f.intent.replace(/\.json$/, `.failed-${f.envelope.messageId}.json`);
    const retained = JSON.stringify({ messageId: f.envelope.messageId, file: "record.json", phase: "failed", note: "an operator's retained record" });
    fs.writeFileSync(tombstone, retained);
    const other = buildSignedEnvelope("kern", agent, "reused", { kern: seed }, { messageId: "reused-name-id" });
    fs.writeFileSync(f.source, JSON.stringify({
      id: "reused-record", from: "kern", to: agent, body: JSON.stringify(other), timestamp: other.timestamp,
    }));

    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(await mail.checkMessages(agent)).toEqual([]);

    expect(textOf(join(f.inbox.dlq, "record.json.reason")) ?? "").toContain("failed tombstone occupied for record.json");
    expect(textOf(join(f.inbox.dlq, "record.json.reason")) ?? "").toContain("class: storage-unavailable");
    expect(fs.existsSync(f.cur)).toBe(false);
    expect(f.intentNow()).toBe(f.intentBytes);
    expect(textOf(tombstone)).toBe(retained);
    expect(hasCommittedMessageId(f.inbox.root, "reused-name-id")).toBe(false);
  });
});
