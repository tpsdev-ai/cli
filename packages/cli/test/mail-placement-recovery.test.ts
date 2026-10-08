import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommittedMessageId, mailboxReplayStore } from "@tpsdev-ai/agent";
import { runMail } from "../src/commands/mail.js";
import * as mail from "../src/utils/mail.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

const agent = "placement-test";
const seed = Buffer.alloc(32, 0x22);
let root: string;
let savedMailDir: string | undefined;
let verifier: ReturnType<typeof spyOn>;
const faults: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "placement-recovery-"));
  savedMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({
    id: "kern", name: "kern", publicKey: pubkeyFromSeed(seed).toString("base64"),
  });
});

afterEach(() => {
  for (const fault of faults.splice(0)) fault.mockRestore();
  verifier.mockRestore();
  if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = savedMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function plant(messageId = "pending-delivery") {
  const inbox = mail.getInbox(agent);
  const envelope = buildSignedEnvelope("kern", agent, "hello", { kern: seed }, { messageId });
  const record = { id: "record-id", from: "kern", to: agent, body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false };
  const source = join(inbox.fresh, "record.json");
  fs.writeFileSync(source, JSON.stringify(record));
  return { inbox, envelope, record, source, cur: join(inbox.cur, "record.json") };
}

function pending() {
  const fixture = plant();
  const { inbox, envelope, record, cur } = fixture;
  const scratch = join(inbox.tmp, "record.json.promote");
  fs.writeFileSync(scratch, JSON.stringify({
    ...record, body: envelope.body, envelopeId: envelope.messageId, envelope,
    checkedOutAt: new Date().toISOString(), checkedOutBy: agent, deliveryAttempts: 1,
  }));
  mailboxReplayStore(inbox.root).beginPlacement(envelope.messageId, "record.json", scratch);
  fs.linkSync(scratch, cur);
  return fixture;
}

function intents(inbox: ReturnType<typeof mail.getInbox>) {
  return fs.readdirSync(inbox.root).filter((name) => name.startsWith(".placement-") && name.endsWith(".json"));
}

for (const check of ["signature", "binding", "source equality", "record identity", "null", "json"] as const) {
  test(`pending recovery quarantines cur with invalid ${check}`, async () => {
    const { source, cur, inbox, envelope } = pending();
    const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
    if (check === "signature") copy.envelope.signature = "00".repeat(64);
    if (check === "binding") copy.body = "other";
    if (check === "source equality") {
      copy.envelope = buildSignedEnvelope("kern", agent, "other", { kern: seed }, { messageId: envelope.messageId });
      copy.body = copy.envelope.body;
      copy.timestamp = copy.envelope.timestamp;
    }
    if (check === "record identity") copy.id = "other-record";
    fs.writeFileSync(cur, check === "null" ? "null" : check === "json" ? "{" : JSON.stringify(copy));
    const result = await mail.promote(agent, source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.class).toBe("unverified");
    expect(result.reason).toContain("placement-copy-mismatch");
    expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
    expect(fs.existsSync(cur)).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
    expect(intents(inbox)).toEqual([]);
    const dlq = join(inbox.dlq, "record.json");
    expect(fs.existsSync(dlq)).toBe(true);
    const reason = fs.readFileSync(`${dlq}.reason`, "utf8");
    expect(reason).toContain("placement-copy-mismatch");
    expect(reason).toContain("class: unverified");
    const before = fs.statSync(dlq).mtimeMs;
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(fs.statSync(dlq).mtimeMs).toBe(before);
    expect(fs.readdirSync(inbox.dlq).filter((name) => name.endsWith(".json"))).toEqual(["record.json"]);
  });
}

test("an unconsumed filename collision remains retryable after repeated checks", async () => {
  const { source, cur, inbox } = plant("delivered-id");
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
  const before = fs.readFileSync(cur, "utf8");
  const envelope = buildSignedEnvelope("kern", agent, "different", { kern: seed }, { messageId: "collision-id" });
  fs.writeFileSync(source, JSON.stringify({
    id: "collision-record", from: "kern", to: agent, body: JSON.stringify(envelope), timestamp: envelope.timestamp,
  }));
  for (const _ of [0, 1]) {
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(fs.readFileSync(cur, "utf8")).toBe(before);
    expect(fs.readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("class: storage-unavailable");
    expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
  }
});

for (const binding of ["different inode", "legacy intent"] as const) {
  test(`pending mismatch with ${binding} preserves a pre-existing cur collision`, async () => {
    const { source, cur, inbox, envelope, record } = plant();
    const collision = JSON.stringify({ ...record, id: "pre-existing", body: "other" });
    fs.writeFileSync(cur, collision);
    const scratch = join(inbox.tmp, "record.json.promote");
    fs.writeFileSync(scratch, JSON.stringify(record));
    mailboxReplayStore(inbox.root).beginPlacement(envelope.messageId, "record.json", binding === "different inode" ? scratch : undefined);
    for (const path of [source, join(inbox.dlq, "record.json")]) {
      const result = await mail.promote(agent, path);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.class).toBe("storage-unavailable");
      expect(fs.readFileSync(cur, "utf8")).toBe(collision);
      expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
      expect(fs.readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("class: storage-unavailable");
      expect(intents(inbox)).toHaveLength(1);
    }
  });
}

for (const read of [false, true]) {
  test(`pending recovery keeps a same-envelope cur record at another inode retryable (read: ${read})`, async () => {
    const { source, cur, inbox, envelope } = pending();
    const bytes = JSON.stringify({ ...JSON.parse(fs.readFileSync(cur, "utf8")), read });
    fs.rmSync(cur);
    fs.writeFileSync(cur, bytes);
    for (const path of [source, join(inbox.dlq, "record.json")]) {
      const result = await mail.promote(agent, path);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.class).toBe("storage-unavailable");
      expect(fs.readFileSync(cur, "utf8")).toBe(bytes);
      expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
      expect(fs.readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("class: storage-unavailable");
      expect(intents(inbox)).toHaveLength(1);
    }
  });
}

test("committed pending recovery uses the cur lease", async () => {
  const { source, cur, inbox, record } = plant();
  const unlink = fs.unlinkSync;
  const fault = spyOn(fs, "unlinkSync").mockImplementation((path) => {
    if (String(path).includes(".placement-")) throw new Error("intent cleanup unavailable");
    return unlink(path);
  });
  faults.push(fault);
  expect((await mail.promote(agent, source)).ok).toBe(true);
  expect(intents(inbox)).toHaveLength(1);
  fault.mockRestore();
  fs.writeFileSync(source, JSON.stringify(record));
  const result = await mail.promote(agent, source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.class).toBe("replay");
  expect(await mail.checkMessages(agent)).toEqual([]);
  const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
  copy.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(cur, JSON.stringify(copy));
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
  expect(await mail.checkMessages(agent)).toEqual([]);
});

test("pending recovery rejects a replanted source with a missing ledger entry", async () => {
  const { source, cur, inbox, record, envelope } = pending();
  const replay = mailboxReplayStore(inbox.root);
  replay.recordConsumed(envelope.messageId);
  fs.writeFileSync(join(inbox.root, "consumed.jsonl"), "");
  expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
  expect(intents(inbox)).toHaveLength(1);
  const before = fs.readFileSync(cur, "utf8");
  fs.writeFileSync(source, JSON.stringify(record));
  const result = await mail.promote(agent, source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.class).toBe("replay");
  expect(fs.readFileSync(cur, "utf8")).toBe(before);
  expect(fs.existsSync(source)).toBe(false);
  expect(await mail.checkMessages(agent)).toEqual([]);
});

test("pending recovery rejects an archived ID with a missing ledger entry", async () => {
  const { source, cur, inbox, envelope } = pending();
  mailboxReplayStore(inbox.root).recordConsumed(envelope.messageId);
  fs.writeFileSync(join(inbox.root, "consumed.jsonl"), "");
  const archive = join(inbox.root, "archive", "old");
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(cur, join(archive, "record.json"));
  const result = await mail.promote(agent, source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.class).toBe("replay");
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.existsSync(cur)).toBe(false);
  expect(await mail.checkMessages(agent)).toEqual([]);
});

test("pending recovery does not commit a cur copy whose ID an archived record holds", async () => {
  const { source, cur, inbox, envelope } = pending();
  mailboxReplayStore(inbox.root).recordConsumed(envelope.messageId);
  fs.writeFileSync(join(inbox.root, "consumed.jsonl"), "");
  const archived = fs.readFileSync(cur, "utf8");
  const archive = join(inbox.root, "archive", "old");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(join(archive, "earlier.json"), archived);
  const result = await mail.promote(agent, source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.class).toBe("replay");
  expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
  expect(fs.existsSync(cur)).toBe(false);
  expect(fs.existsSync(source)).toBe(false);
  expect(intents(inbox)).toEqual([]);
  expect(await mail.checkMessages(agent)).toEqual([]);
  expect(fs.readFileSync(join(archive, "earlier.json"), "utf8")).toBe(archived);
});

test("ledger pruning retains IDs named by pending intents", () => {
  const { inbox, envelope } = pending();
  const replay = mailboxReplayStore(inbox.root);
  replay.recordConsumed(envelope.messageId);
  const ledger = join(inbox.root, "consumed.jsonl");
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(ledger, [envelope.messageId, "unrelated"].map((id) => JSON.stringify({ id, at: old })).join("\n") + "\n");
  expect(replay.isConsumed("absent")).toBe(false);
  expect(fs.readFileSync(ledger, "utf8")).toBe(JSON.stringify({ id: envelope.messageId, at: old }) + "\n");
  expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(true);
});

function age(fixture: ReturnType<typeof pending>) {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const path of [fixture.source, fixture.cur]) {
    const record = JSON.parse(fs.readFileSync(path, "utf8"));
    record.receivedAt = old.toISOString();
    record.checkedOutAt = old.toISOString();
    fs.writeFileSync(path, JSON.stringify(record));
    fs.utimesSync(path, old, old);
  }
}

test("mail gc preserves pending placement files", async () => {
  const fixture = pending();
  age(fixture);
  await runMail({ action: "gc", agent });
  expect(fs.existsSync(fixture.source)).toBe(true);
  expect(fs.existsSync(fixture.cur)).toBe(true);
  expect(intents(fixture.inbox)).toHaveLength(1);
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
});

for (const action of ["archiveOldCur", "checkMessages"] as const) {
  test(`${action} handles unrelated aged cur files and pending placement files`, async () => {
    const fixture = pending();
    age(fixture);
    const copy = JSON.parse(fs.readFileSync(fixture.cur, "utf8"));
    copy.id = "other-record";
    fs.writeFileSync(fixture.cur, JSON.stringify(copy));
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(fixture.cur, old, old);
    const unrelated = join(fixture.inbox.cur, "ancient.json");
    const bytes = JSON.stringify({ id: "ancient", from: "kern", to: agent, body: "old", timestamp: old.toISOString() });
    fs.writeFileSync(unrelated, bytes);
    fs.utimesSync(unrelated, old, old);
    if (action === "archiveOldCur") expect(mail.archiveOldCur(agent)).toBe(1);
    else expect(await mail.checkMessages(agent)).toEqual([]);
    const month = `${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(fs.readFileSync(join(fixture.inbox.root, "archive", month, "ancient.json"), "utf8")).toBe(bytes);
    expect(fs.existsSync(unrelated)).toBe(false);
    expect(fs.existsSync(fixture.cur)).toBe(action === "archiveOldCur");
    expect(fs.existsSync(fixture.source)).toBe(action === "archiveOldCur");
    expect(intents(fixture.inbox)).toHaveLength(action === "archiveOldCur" ? 1 : 0);
    expect(hasCommittedMessageId(fixture.inbox.root, fixture.envelope.messageId)).toBe(false);
  });
}

test("checkMessages reconciles pending placement before archival", async () => {
  const fixture = pending();
  age(fixture);
  const archiveOldCur = mail.archiveOldCur;
  let committedAtArchive = false;
  let pendingAtArchive: string[] = [];
  const archive = spyOn(mail, "archiveOldCur");
  faults.push(archive);
  archive.mockImplementation((...args) => {
    committedAtArchive = hasCommittedMessageId(fixture.inbox.root, fixture.envelope.messageId);
    pendingAtArchive = intents(fixture.inbox);
    return archiveOldCur(...args);
  });
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
  expect(archive).toHaveBeenCalled();
  expect(committedAtArchive).toBe(true);
  expect(pendingAtArchive).toEqual([]);
  expect(await mail.checkMessages(agent)).toEqual([]);
});

test("rollback retains the intent until cur absence is confirmed", async () => {
  const { source, cur, inbox, envelope } = plant();
  const append = fs.appendFileSync;
  faults.push(spyOn(fs, "appendFileSync").mockImplementation(((...args: Parameters<typeof append>) => {
    if (args[0] === join(inbox.root, "consumed.jsonl")) throw new Error("ledger unavailable");
    return append(...args);
  }) as typeof append));
  const remove = fs.rmSync;
  faults.push(spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (path === cur) throw new Error("cur removal unavailable");
    return remove(path, options);
  }));
  expect((await mail.promote(agent, source)).ok).toBe(false);
  expect(fs.existsSync(cur)).toBe(true);
  expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(false);
  expect(intents(inbox)).toHaveLength(1);
  for (const fault of faults.splice(0)) fault.mockRestore();
  expect(await mail.checkMessages(agent)).toEqual([]);
  const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
  copy.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(cur, JSON.stringify(copy));
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
  expect(await mail.checkMessages(agent)).toEqual([]);
});

for (const committed of [true, false]) {
  test(`orphaned pending cur copy ${committed ? "recovers a committed delivery" : "withholds an uncommitted delivery"}`, async () => {
    const { source, cur, inbox, envelope } = pending();
    if (committed) mailboxReplayStore(inbox.root).recordConsumed(envelope.messageId);
    fs.rmSync(source);
    const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
    copy.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cur, JSON.stringify(copy));
    expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(committed ? ["hello"] : []);
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(intents(inbox)).toHaveLength(committed ? 0 : 1);
  });
}

test("a different message at an orphaned committed copy's filename leaves its intent intact", async () => {
  const { source, cur, inbox, envelope } = pending();
  mailboxReplayStore(inbox.root).recordConsumed(envelope.messageId);
  fs.rmSync(source);
  const [intent] = intents(inbox);
  const intentBytes = fs.readFileSync(join(inbox.root, intent!), "utf8");
  const copy = JSON.parse(fs.readFileSync(cur, "utf8"));
  copy.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(cur, JSON.stringify(copy));
  const other = buildSignedEnvelope("kern", agent, "different", { kern: seed }, { messageId: "other-id" });
  fs.writeFileSync(source, JSON.stringify({
    id: "other-record", from: "kern", to: agent, body: JSON.stringify(other), timestamp: other.timestamp,
  }));
  const result = await mail.promote(agent, source);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.class).toBe("storage-unavailable");
  expect(fs.readFileSync(join(inbox.root, intent!), "utf8")).toBe(intentBytes);
  expect(fs.readFileSync(cur, "utf8")).toBe(JSON.stringify(copy));
  expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["hello"]);
  expect(await mail.checkMessages(agent)).toEqual([]);
  expect(intents(inbox)).toEqual([]);
  expect(fs.readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("class: storage-unavailable");
  expect(hasCommittedMessageId(inbox.root, other.messageId)).toBe(false);
});

for (const malformed of ["file", "json", "unknown ID", "invalid escape"] as const) {
  test(`malformed placement ${malformed} retains replay history and permits unrelated mail`, async () => {
    const { inbox, envelope, source, cur } = pending();
    const intent = join(inbox.root, intents(inbox)[0]!);
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(join(inbox.root, "consumed.jsonl"), JSON.stringify({ id: envelope.messageId, at: old }) + "\n");
    const raw = malformed === "file" ? JSON.stringify({ messageId: envelope.messageId, file: "other.json" })
      : malformed === "json" ? `{"messageId":"${envelope.messageId}",`
        : malformed === "invalid escape" ? '{"messageId":"\\q",' : "{";
    fs.writeFileSync(intent, raw);
    const unrelated = buildSignedEnvelope("kern", agent, "unrelated", { kern: seed }, { messageId: "unrelated" });
    fs.writeFileSync(join(inbox.fresh, "unrelated.json"), JSON.stringify({
      id: "unrelated-record", from: "kern", to: agent, body: JSON.stringify(unrelated), timestamp: unrelated.timestamp,
    }));
    expect((await mail.checkMessages(agent)).map((msg) => msg.body)).toEqual(["unrelated"]);
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(hasCommittedMessageId(inbox.root, envelope.messageId)).toBe(true);
    expect(fs.existsSync(cur)).toBe(true);
    expect(fs.existsSync(intent)).toBe(false);
    expect(fs.readFileSync(`${intent}.quarantined`, "utf8")).toBe(raw);
    expect(fs.readFileSync(`${intent}.quarantined.reason`, "utf8")).toContain(intent);
    expect(fs.readFileSync(`${intent}.quarantined.reason`, "utf8")).toContain("MalformedPlacementIntentError");
    expect(fs.existsSync(join(inbox.dlq, "unrelated.json"))).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
    fs.rmSync(cur);
    fs.writeFileSync(join(inbox.fresh, "duplicate.json"), JSON.stringify({
      id: "duplicate-record", from: "kern", to: agent, body: JSON.stringify(envelope), timestamp: envelope.timestamp,
    }));
    expect(await mail.checkMessages(agent)).toEqual([]);
    expect(fs.readFileSync(join(inbox.dlq, "duplicate.json.reason"), "utf8")).toContain("class: replay");
  });
}
