import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ackMessageAtPath, getInbox, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal, pruneRelayAcceptanceReceipts, relayAcceptanceReceiptPath, startRelay } from "../src/utils/relay.js";

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-accept-invariants-"));
  saved = Object.fromEntries(["HOME", "TPS_MAIL_DIR", "TPS_RELAY_ACCEPT_PRUNE_INTERVAL_MS"].map((key) => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => { mock.restore(); });

function body() {
  return { id: randomUUID(), from: "remote", to: "local", content: "private-payload-text", timestamp: new Date().toISOString() };
}

function records(): string[] {
  const inbox = getInbox("local");
  return fs.readdirSync(inbox.fresh).filter((file) => file.endsWith(".json"));
}

test("receipt write failure removes the new record before retry, ACK, and resend", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const write = fs.writeFileSync;
  const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
    if (String(path) === `${marker}.tmp`) throw new Error(`receipt failure ${item.content}`);
    return write(path, data, options);
  });
  let refusal = "";
  try {
    try { deliverRelayedToLocal("remote", item); }
    catch (error) { refusal = String(error); }
  }
  finally { fault.mockRestore(); }
  expect(refusal).toContain("relay acceptance receipt write failed; retry delivery");
  expect(refusal).not.toContain(item.content);
  expect(records()).toEqual([]);
  expect(fs.existsSync(marker)).toBe(false);
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  const [file] = records();
  ackMessageAtPath(join(getInbox("local").fresh, file!));
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(records()).toEqual([]);
  expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
  expect(errors.mock.calls.flat().join("\n")).not.toContain(item.content);
  errors.mockRestore();
});

test("record publication failure leaves no receipt and resend publishes once", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const rename = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).startsWith(getInbox("local").fresh)) throw new Error("injected record publication failure");
    return rename(from, to);
  });
  try { expect(() => deliverRelayedToLocal("remote", item)).toThrow(); }
  finally { fault.mockRestore(); }
  expect(fs.existsSync(marker)).toBe(false);
  expect(records()).toEqual([]);
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(records()).toHaveLength(1);
});

test("inbox write failures remain unacked and retryable", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const tmp = getInbox("local").tmp;
  const write = fs.writeFileSync;
  const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
    if (String(path).startsWith(tmp)) throw new Error("Inbox full: injected write failure");
    return write(path, data, options);
  });
  try { expect(() => deliverRelayedToLocal("remote", item)).toThrow("relay inbox write failed; retry delivery"); }
  finally { fault.mockRestore(); }
  expect(fs.existsSync(marker)).toBe(false);
  expect(records()).toEqual([]);
  expect(deliverRelayedToLocal("remote", item)).toBe(true);
  expect(records()).toHaveLength(1);
});

test("a receipt rollback sync failure preserves the record and warns of a possible duplicate", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const paths = new Map<number, string>();
  const opened = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    paths.set(fd, String(path));
    return fd;
  });
  const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (paths.get(fd) === dirname(marker)) throw new Error("injected receipt directory sync failure");
    return sync(fd);
  });
  let refusal = "";
  try {
    try { deliverRelayedToLocal("remote", item); }
    catch (error) { refusal = String(error); }
  } finally {
    fault.mockRestore();
    opened.mockRestore();
  }
  expect(refusal).toContain("retry may duplicate");
  expect(refusal).not.toContain(item.content);
  expect(fs.existsSync(marker)).toBe(false);
  expect(records()).toHaveLength(1);
});

test("old day buckets with more than one former pass expire together", () => {
  const accepted = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote");
  for (const day of ["2020-01-01", "2020-01-02"]) {
    const bucket = join(accepted, day);
    fs.mkdirSync(bucket, { recursive: true });
    for (let i = 0; i < 2050; i++) fs.writeFileSync(join(bucket, `receipt-${i}`), "x");
  }
  expect(pruneRelayAcceptanceReceipts(accepted, Date.now(), 1000)).toBe(2);
  expect(fs.readdirSync(accepted)).toEqual([]);
});

test("a flat per-branch marker with a live record remains an in-flight duplicate", () => {
  const item = body();
  const original = sendMessage(item.to, item.content, item.from, { branchId: "remote", id: item.id }, item.timestamp);
  const flatMarker = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote", item.id);
  fs.mkdirSync(dirname(flatMarker), { recursive: true });
  fs.writeFileSync(flatMarker, "");
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(records()).toHaveLength(1);
  expect(fs.existsSync(relayAcceptanceReceiptPath("remote", item.id))).toBe(true);
  ackMessageAtPath(original.filePath);
  expect(deliverRelayedToLocal("remote", item)).toBe(false);
  expect(records()).toEqual([]);
});

test("flat per-branch markers expire with receipts", () => {
  const accepted = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote");
  fs.mkdirSync(accepted, { recursive: true });
  const old = join(accepted, randomUUID());
  const current = join(accepted, randomUUID());
  fs.writeFileSync(old, "");
  fs.writeFileSync(current, "");
  fs.utimesSync(old, new Date(0), new Date(0));
  expect(pruneRelayAcceptanceReceipts(accepted, Date.now(), 1000)).toBe(1);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(current)).toBe(true);
});

test("relay timer retries a failed prune without a new delivery", async () => {
  const accepted = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote");
  const old = join(accepted, "2020-01-01");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(join(old, "receipt"), "x");
  process.env.TPS_RELAY_ACCEPT_PRUNE_INTERVAL_MS = "10";
  const remove = fs.rmSync;
  let calls = 0;
  const fault = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (String(path) === old && calls++ === 0) throw new Error("injected prune failure");
    return remove(path, options);
  });
  const stop = startRelay("local");
  try {
    const deadline = Date.now() + 1000;
    while (fs.existsSync(old) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(old)).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    stop();
    fault.mockRestore();
  }
});
