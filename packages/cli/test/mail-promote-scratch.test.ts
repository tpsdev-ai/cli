import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as mail from "../src/utils/mail.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

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

function plant(body: string) {
  const inbox = mail.getInbox(agent);
  const envelope = buildSignedEnvelope("kern", agent, body, { kern: seed });
  const path = join(inbox.fresh, "record.json");
  fs.writeFileSync(path, JSON.stringify({ id: envelope.messageId, from: "kern", to: agent, body: JSON.stringify(envelope) }));
  return path;
}

test("direct promotion preserves a stranded hard-linked cur record and rejects different content", async () => {
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
  expect(result.class).toBe("invalid");
  expect(result.reason).toContain("different delivery content");
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
