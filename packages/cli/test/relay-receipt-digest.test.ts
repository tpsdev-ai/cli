/**
 * relay-receipt-digest.test.ts — cli#579.
 *
 * A new relay acceptance receipt binds a branch+id to the digest and byte length
 * of the accepted payload, not the payload itself, so the receipt's size does not
 * grow with what a sender sends.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ackMessageAtPath, getInbox, MAX_INBOX_MESSAGES, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal, relayAcceptanceReceiptPath } from "../src/utils/relay.js";

const sha256 = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
const byteLength = (content: string): number => Buffer.byteLength(content, "utf8");

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-receipt-digest-"));
  saved = Object.fromEntries(["HOME", "TPS_MAIL_DIR"].map((key) => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
});

afterEach(() => { mock.restore(); });

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function body(content = "private-payload-text") {
  return { id: randomUUID(), from: "remote", to: "local", content, timestamp: new Date().toISOString() };
}

function freshFiles(): string[] {
  return fs.readdirSync(getInbox("local").fresh).filter((file) => file.endsWith(".json"));
}

function ackOnlyRecord(): void {
  const [file] = freshFiles();
  ackMessageAtPath(join(getInbox("local").fresh, file!));
  expect(freshFiles()).toEqual([]);
}

test("an accepted large payload leaves a receipt under 1 KB that holds no content bytes", () => {
  const marker = `MARKER-${randomUUID()}`;
  const content = `${marker}${"x".repeat(60 * 1024)}`;
  const item = body(content);
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  ackOnlyRecord();
  const raw = fs.readFileSync(relayAcceptanceReceiptPath("remote", item.id), "utf8");
  expect(byteLength(raw)).toBeLessThan(1024);
  expect(raw).not.toContain(marker);
  expect(JSON.parse(raw)).toEqual({
    from: item.from,
    to: item.to,
    timestamp: item.timestamp,
    bodySha256: sha256(content),
    bodyLength: byteLength(content),
  });
});

test("a 5 MB payload leaves a receipt under 1 KB that holds no content bytes", () => {
  const marker = `MARKER-${randomUUID()}`;
  const content = `${marker}${"x".repeat(5 * 1024 * 1024)}`;
  const item = body(content);
  spyOn(console, "error").mockImplementation(() => {});
  // Over the inbox body cap, so the relay dead-letters and ACKs it; either way
  // the receipt is tiny.
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  const raw = fs.readFileSync(relayAcceptanceReceiptPath("remote", item.id), "utf8");
  expect(byteLength(raw)).toBeLessThan(1024);
  expect(raw).not.toContain(marker);
});

test("an identical resend after ACK is judged identical", () => {
  const item = body();
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  ackOnlyRecord();
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(freshFiles()).toEqual([]);
});

test("a resend with different content of the same length is judged different", () => {
  const item = body("AAAAAAAAAAAAAAAAAAAA");
  const changed = { ...item, content: "B".repeat(item.content.length) };
  expect(changed.content.length).toBe(item.content.length);
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  ackOnlyRecord();
  expect(() => deliverRelayedToLocal("remote", changed)).toThrow(/conflict/);
  expect(freshFiles()).toEqual([]);
});

test("a pre-digest receipt on disk still judges a resend and is left as written", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  fs.mkdirSync(dirname(marker), { recursive: true });
  const stored = JSON.stringify({ from: item.from, to: item.to, body: item.content, timestamp: item.timestamp });
  fs.writeFileSync(marker, stored);

  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(freshFiles()).toEqual([]);
  const changed = { ...item, content: "z".repeat(item.content.length) };
  expect(() => deliverRelayedToLocal("remote", changed)).toThrow(/conflict/);
  expect(fs.readFileSync(marker, "utf8")).toBe(stored);
});

test("a receipt matching neither shape fails closed like an unreadable one", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  fs.mkdirSync(dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, bodyLength: 3 }));
  spyOn(console, "error").mockImplementation(() => {});
  expect(() => deliverRelayedToLocal("remote", item)).toThrow(`relayed delivery conflict for branch remote message ${item.id}`);
  expect(freshFiles()).toEqual([]);
});

test("the dead-letter receipt is digest-only", () => {
  for (let i = 0; i < MAX_INBOX_MESSAGES; i++) sendMessage("local", `filler-${i}`, "seeder");
  const marker = `MARKER-${randomUUID()}`;
  const item = body(`${marker} undeliverable payload`);
  spyOn(console, "error").mockImplementation(() => {});
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(fs.readdirSync(getInbox("local").dlq).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  const raw = fs.readFileSync(relayAcceptanceReceiptPath("remote", item.id), "utf8");
  expect(raw).not.toContain(marker);
  expect(JSON.parse(raw)).toEqual({
    from: item.from,
    to: item.to,
    timestamp: item.timestamp,
    bodySha256: sha256(item.content),
    bodyLength: byteLength(item.content),
  });
});
