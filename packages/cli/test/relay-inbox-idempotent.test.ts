/**
 * relay-inbox-idempotent.test.ts — cli#513.
 *
 * Relay delivery into the local inbox is idempotent by authenticated branch and
 * delivery id: the same id from the same branch twice yields exactly one inbox
 * record, even when the acceptance marker was not written, and the same id from
 * a different branch is still delivered. The record is named by a key derived
 * from the AUTHENTICATED branch id and the wire delivery id (never from a field
 * of the record), so a resend is recognised by that key.
 *
 * These tests exercise the real relay acceptance path, not a fake store:
 * `syncRemoteBranch` receives MAIL_DELIVER frames over a channel and ACKs them,
 * and `deliverRelayedToLocal` is the acceptance entry point the receiver uses.
 */
import { afterEach, beforeEach, describe, expect, spyOn, mock, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getInbox, sendMessage } from "../src/utils/mail.js";
import { syncRemoteBranch, deliverRelayedToLocal, relayAcceptanceReceiptPath } from "../src/utils/relay.js";
import { generateKeyPair, initHostIdentity, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import { writeBranchConf } from "../src/commands/branch.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, MSG_HEARTBEAT, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";

afterEach(() => { mock.restore(); });

describe("relay inbox writes are idempotent by branch and delivery id (cli#513)", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let handlers: Set<(msg: TpsMessage) => void>;
  let acks: TpsMessage[];
  let channel: TransportChannel;

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-relay-513-"));
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "relay-test";
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    await initHostIdentity();
    for (const branchId of ["remote", "remote-b"]) {
      const kp = generateKeyPair();
      registerBranch(branchId, kp.signing.publicKey, undefined, kp.encryption.publicKey);
      const branchDir = join(root, ".tps", "branch-office", branchId);
      fs.mkdirSync(branchDir, { recursive: true });
      fs.writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
    }
    const kp = generateKeyPair();
    saveKeyPair(kp, process.env.TPS_IDENTITY_DIR!, "branch");
    writeBranchConf(1, "unused", "ws", undefined, "remote");
    handlers = new Set();
    acks = [];
    channel = {
      async send(msg) { if (msg.type === MSG_MAIL_ACK) acks.push(msg); },
      onMessage(handler) { handlers.add(handler); },
      offMessage(handler) { handlers.delete(handler); },
      async close() {},
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    };
    spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mailBody(branchId = "remote", content = "relay payload"): MailDeliverBody {
    return { id: randomUUID(), from: branchId, to: "local", content, timestamp: new Date().toISOString() };
  }

  function newRecords(): string[] {
    const inbox = getInbox("local");
    return fs.existsSync(inbox.fresh) ? fs.readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")) : [];
  }

  async function receive(body: MailDeliverBody): Promise<void> {
    const done = syncRemoteBranch("remote");
    for (let i = 0; handlers.size === 0 && i < 100; i++) await Bun.sleep(10);
    expect(handlers.size).toBeGreaterThan(0);
    for (const handler of handlers) handler({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
    await done;
  }

  test("a marker write failure, a lost ACK and a resend of the same id yield one record and an ACK", async () => {
    const body = mailBody();
    const marker = relayAcceptanceReceiptPath("remote", body.id);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const write = fs.writeFileSync;
    const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
      if (String(path) === `${marker}.tmp`) throw new Error("injected marker write failure");
      return write(path, data, opts);
    });
    try { await receive(body); }
    finally { fault.mockRestore(); }
    // The marker write failed, so the delivery withheld its ACK and rolled its record back.
    expect(acks).toEqual([]);
    expect(newRecords()).toEqual([]);
    // The sender resends the same id from the same branch.
    await receive(body);
    expect(newRecords()).toHaveLength(1);
    expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
    expect(errors.mock.calls.flat().join("\n")).toContain("relay acceptance receipt write failed");
  }, 20_000);

  test("the same id from a different branch is delivered for each branch", () => {
    const id = randomUUID();
    const first = { id, from: "remote", to: "local", content: "one", timestamp: new Date().toISOString() };
    const second = { id, from: "remote-b", to: "local", content: "two", timestamp: new Date().toISOString() };
    expect(deliverRelayedToLocal("remote", first)).toBe(true);
    expect(deliverRelayedToLocal("remote-b", second)).toBe(true);
    expect(newRecords()).toHaveLength(2);
  });

  test("a crash between the inbox write and the marker write is not written a second time on the resend", () => {
    const body = mailBody();
    // The inbox write happened (the real relay record), the marker write did not.
    sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
    expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
    expect(deliverRelayedToLocal("remote", body)).toBe(false);
    expect(newRecords()).toHaveLength(1);
  });

  test("a resend is recognised by the record's (branch, id) key, not by a field on the record", () => {
    const body = mailBody();
    const placed = sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
    // Strip the record's relay fields: the record is identified by its keyed name.
    const record = JSON.parse(fs.readFileSync(placed.filePath, "utf8"));
    delete record.relayDelivery;
    delete record.relayPayload;
    delete record.relayWireTo;
    delete record.receivedAt;
    fs.writeFileSync(placed.filePath, JSON.stringify(record));
    expect(deliverRelayedToLocal("remote", body)).toBe(false);
    expect(newRecords()).toHaveLength(1);
  });
});
