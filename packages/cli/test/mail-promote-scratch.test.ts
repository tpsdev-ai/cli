import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as mail from "../src/utils/mail.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const agent = "scratch-test";
const seed = Buffer.alloc(32, 0x22);
let root: string;
let priorMailDir: string | undefined;
let verifier: ReturnType<typeof spyOn>;
let fault: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "promote-scratch-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({
    id: "kern", name: "kern", publicKey: pubkeyFromSeed(seed).toString("base64"),
  });
});
afterEach(() => {
  fault?.mockRestore();
  fault = undefined;
  verifier.mockRestore();
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function plant(body: string, messageId?: string) {
  const inbox = mail.getInbox(agent);
  const envelope = buildSignedEnvelope("kern", agent, body, { kern: seed }, { messageId });
  const path = join(inbox.fresh, "record.json");
  fs.writeFileSync(path, JSON.stringify({ id: envelope.messageId, from: "kern", to: agent, body: JSON.stringify(envelope) }));
  return path;
}

test("direct promotion and the scratch sweep preserve a stranded hard-linked cur record", async () => {
  expect((await mail.promote(agent, plant("original"))).ok).toBe(true);
  const inbox = mail.getInbox(agent);
  const cur = join(inbox.cur, "record.json");
  const scratch = join(inbox.tmp, "record.json.promote");
  fs.linkSync(cur, scratch);
  fs.writeFileSync(join(inbox.root, "consumed.jsonl"), "");
  const before = fs.readFileSync(cur, "utf8");
  expect(fs.statSync(scratch).ino).toBe(fs.statSync(cur).ino);
  expect(fs.statSync(scratch).nlink).toBe(2);
  expect(await mail.isPresentableCurRecord(agent, JSON.parse(before), root)).toBe(false);

  const result = await mail.promote(agent, plant("different"));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("collision accepted");
  expect(result.class).toBe("storage-unavailable");
  expect(fs.readFileSync(cur, "utf8")).toBe(before);
  expect(fs.readFileSync(scratch, "utf8")).toBe(before);
  expect(fs.existsSync(join(inbox.dlq, "record.json"))).toBe(true);

  expect(await mail.sweepStrandedPromoteScratch(inbox.root)).toBe(1);
  expect(fs.existsSync(scratch)).toBe(false);
  expect(fs.statSync(cur).nlink).toBe(1);
  expect(fs.readFileSync(cur, "utf8")).toBe(before);
  fs.writeFileSync(join(inbox.fresh, "record.json"), JSON.stringify({
    id: "retry", from: "kern", to: agent, body: JSON.stringify(JSON.parse(before).envelope),
  }));
  const retry = await mail.promote(agent, join(inbox.fresh, "record.json"));
  expect(retry.ok).toBe(false);
  if (retry.ok) throw new Error("uncommitted record retried");
  expect(retry.class).toBe("replay");
});

test("exclusive scratch creation refuses an existing hard link without changing its bytes", async () => {
  expect((await mail.promote(agent, plant("original"))).ok).toBe(true);
  const inbox = mail.getInbox(agent);
  const cur = join(inbox.cur, "record.json");
  const before = fs.readFileSync(cur, "utf8");
  const incoming = plant("different");
  const write = fs.writeFileSync;
  let planted: string | undefined;
  fault = spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof write>) => {
    if (typeof args[0] === "string" && args[0].endsWith(".promote")) {
      planted = args[0];
      fs.linkSync(cur, planted);
    }
    return write(...args);
  }) as typeof write);
  const result = await mail.promote(agent, incoming);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("existing scratch accepted");
  expect(result.class).toBe("storage-unavailable");
  expect(planted).toBeDefined();
  expect(fs.readFileSync(cur, "utf8")).toBe(before);
  expect(fs.readFileSync(planted!, "utf8")).toBe(before);
  expect(await mail.sweepStrandedPromoteScratch(inbox.root)).toBe(1);
  expect(fs.readFileSync(cur, "utf8")).toBe(before);
});

for (const body of ["original", "different"]) {
  test(`consumed ID at the same filename with ${body} signed body returns replay`, async () => {
    const messageId = "consumed-collision";
    expect((await mail.promote(agent, plant("original", messageId))).ok).toBe(true);
    const inbox = mail.getInbox(agent);
    const cur = join(inbox.cur, "record.json");
    const before = fs.readFileSync(cur, "utf8");
    const ledger = fs.readFileSync(join(inbox.root, "consumed.jsonl"), "utf8");
    const result = await mail.promote(agent, plant(body, messageId));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("consumed collision accepted");
    expect(result.class).toBe("replay");
    expect(fs.readFileSync(cur, "utf8")).toBe(before);
    expect(fs.readFileSync(join(inbox.root, "consumed.jsonl"), "utf8")).toBe(ledger);
    expect(fs.readdirSync(inbox.tmp)).toEqual([]);
  });
}

for (const kind of ["record", "directory", "symlink"] as const) {
  test(`an unconsumed ID colliding with a ${kind} is retryable`, async () => {
    const source = plant("retry", "unconsumed-collision");
    const original = fs.readFileSync(source);
    const inbox = mail.getInbox(agent);
    const cur = join(inbox.cur, "record.json");
    const existing = JSON.stringify({ envelopeId: "other-consumed-id", body: "existing" });
    if (kind === "directory") fs.mkdirSync(cur);
    else if (kind === "symlink") {
      const target = join(root, "existing.json");
      fs.writeFileSync(target, existing);
      fs.symlinkSync(target, cur);
    } else fs.writeFileSync(cur, existing);
    const inode = fs.lstatSync(cur).ino;
    const result = await mail.promote(agent, source);
    expect(result).toEqual({
      ok: false, class: "storage-unavailable",
      reason: "storage failure during promote: destination already exists: record.json",
    });
    expect(fs.lstatSync(cur).ino).toBe(inode);
    if (kind !== "directory") expect(fs.readFileSync(cur, "utf8")).toBe(existing);
    expect(fs.readFileSync(join(inbox.dlq, "record.json"))).toEqual(original);
    expect(fs.readFileSync(join(inbox.dlq, "record.json.reason"), "utf8")).toContain("class: storage-unavailable");
    expect(fs.existsSync(join(inbox.root, "consumed.jsonl"))).toBe(false);
    fs.rmSync(cur, { recursive: true, force: true });
    const retried = await mail.redriveRetryable(agent, inbox.dlq);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.message.envelopeId).toBe("unconsumed-collision");
  });
}
