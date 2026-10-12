import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findRelayedRecord, getInbox, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal } from "../src/utils/relay.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";
import { buildSignedEnvelope, writeKeyFile } from "./helpers/stub-flair.js";

const MAIL_URL = new URL("../src/utils/mail.js", import.meta.url).href;
const STUB_URL = new URL("./helpers/stub-flair.js", import.meta.url).href;
const PROMOTE_CHILD = `
const { promote } = await import(${JSON.stringify(MAIL_URL)});
const { installStubFlairFetch } = await import(${JSON.stringify(STUB_URL)});
const stub = installStubFlairFetch({ sender: Buffer.alloc(32, 1), "agent-a": Buffer.alloc(32, 2) });
try {
  process.env.FLAIR_URL = stub.url;
  const result = await promote("agent-a", process.env.PROMOTE_SOURCE);
  if (!result.ok) {
    if (result.class !== "busy") throw new Error(JSON.stringify(result));
    process.stdout.write("blocked");
  }
} finally { stub.stop(); }
`;

const NACK_CHILD = `
const { nackMessage } = await import(${JSON.stringify(MAIL_URL)});
try {
  if (!nackMessage("agent-a", process.env.NACK_ID, "permanent failure", "permanent")) throw new Error("record missing");
  process.stdout.write("moved");
} catch (error) {
  if (!String(error).includes("mail lock contention timeout")) throw error;
  process.stdout.write("blocked");
}
`;

let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-scan-promotion-"));
  savedEnv = {};
  for (const key of ["HOME", "TPS_MAIL_DIR", "FLAIR_KEY_PATH"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
  process.env.FLAIR_KEY_PATH = writeKeyFile(join(root, "keys"), "agent-a", Buffer.alloc(32, 2));
});

afterEach(() => { mock.restore(); });

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const phase of ["before", "after"] as const) {
  test(`scan finds the record while promotion is attempted ${phase} the dlq directory read without a receipt`, () => {
    const envelope = buildSignedEnvelope("sender", "agent-a", "payload", { sender: Buffer.alloc(32, 1) });
    const delivery = { branchId: "remote", id: randomUUID() };
    const payload = { from: "sender", to: "agent-a", body: JSON.stringify(envelope), timestamp: envelope.timestamp };
    const record = sendMessage(payload.to, payload.body, payload.from, delivery, payload.timestamp);
    const inbox = getInbox("agent-a");
    const source = join(inbox.dlq, basename(record.filePath));
    fs.renameSync(record.filePath, source);
    const heldRoot = getInbox("agent-z").root;
    expect(inbox.root < heldRoot).toBe(true);
    expect(fs.existsSync(join(process.env.TPS_MAIL_DIR!, ".relay-accepted"))).toBe(false);
    const childScript = join(root, "promote.ts");
    fs.writeFileSync(childScript, PROMOTE_CHILD);
    const readDirectory = fs.readdirSync;
    let attempted = false;
    let promoted = false;
    const move = () => {
      const result = spawnSync("bun", [childScript], {
        env: { ...process.env, PROMOTE_SOURCE: source }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      attempted = true;
      promoted = result.stdout !== "blocked";
      expect(fs.existsSync(source)).toBe(!promoted);
    };
    const held = acquireMailLockSync(heldRoot);
    expect(held).not.toBeNull();
    const scan = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof readDirectory>) => {
      const trigger = args[0] === inbox.dlq && !attempted;
      if (trigger && phase === "before") move();
      const entries = readDirectory(...args);
      if (trigger && phase === "after") move();
      return entries;
    }) as typeof readDirectory);
    try {
      expect(findRelayedRecord("agent-z", delivery, payload, "agent-a", { heldRoot }))
        .toBe(promoted ? join(inbox.cur, basename(source)) : source);
      expect(attempted).toBe(true);
    } finally {
      scan.mockRestore();
      held?.release();
    }
    if (!promoted) {
      move();
      expect(promoted).toBe(true);
      expect(fs.existsSync(join(inbox.cur, basename(source)))).toBe(true);
    }
  });
}

test("permanent NACK attempted between dlq and cur reads refuses a conflicting resend without a receipt", () => {
  const delivery = { branchId: "remote", id: randomUUID() };
  const payload = { from: "sender", to: "agent-a", body: "payload", timestamp: new Date().toISOString() };
  const record = sendMessage(payload.to, payload.body, payload.from, delivery, payload.timestamp);
  const inbox = getInbox("agent-a");
  fs.renameSync(record.filePath, join(inbox.cur, basename(record.filePath)));
  const heldRoot = getInbox("agent-z").root;
  expect(inbox.root < heldRoot).toBe(true);
  expect(fs.existsSync(join(process.env.TPS_MAIL_DIR!, ".relay-accepted"))).toBe(false);
  const readDirectory = fs.readdirSync;
  const childScript = join(root, "nack.ts");
  fs.writeFileSync(childScript, NACK_CHILD);
  let attempted = false;
  let moved = false;
  let refused = false;
  let accepted = false;
  const scan = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof readDirectory>) => {
    const entries = readDirectory(...args);
    if (args[0] === inbox.dlq && !attempted) {
      attempted = true;
      const result = spawnSync("bun", [childScript], {
        env: { ...process.env, NACK_ID: record.id }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      moved = result.stdout === "moved";
      expect(fs.existsSync(join(inbox.dlq, basename(record.filePath)))).toBe(moved);
    }
    return entries;
  }) as typeof readDirectory);
  try {
    try { accepted = deliverRelayedToLocal(delivery.branchId, { id: delivery.id, from: payload.from, to: "agent-z", content: payload.body, timestamp: payload.timestamp }); }
    catch (error) {
      expect(String(error)).toContain("relayed delivery conflict");
      refused = true;
    }
    expect(attempted).toBe(true);
    expect(refused).toBe(true);
    expect(accepted).toBe(false);
    expect(fs.readdirSync(getInbox("agent-z").fresh)).toHaveLength(0);
    expect(fs.readdirSync(inbox.cur).length + fs.readdirSync(inbox.dlq).filter((file) => file.endsWith(".json")).length).toBe(1);
  } finally {
    scan.mockRestore();
  }
  if (!moved) {
    const result = spawnSync("bun", [childScript], {
      env: { ...process.env, NACK_ID: record.id }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("moved");
  }
  expect(fs.existsSync(join(inbox.dlq, basename(record.filePath)))).toBe(true);
  expect(() => deliverRelayedToLocal(delivery.branchId, { id: delivery.id, from: payload.from, to: "agent-z", content: payload.body, timestamp: payload.timestamp })).toThrow("relayed delivery conflict");
});
