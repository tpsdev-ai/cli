/**
 * relay-inbox-idempotent.test.ts — cli#513.
 *
 * A relayed inbox record is named by a key derived from the AUTHENTICATED branch
 * id and the wire delivery id, so a resend of the same id from the same branch is
 * matched to that record by its name rather than by the record's relay fields,
 * even when the acceptance receipt was not written. The same id from a different
 * branch has a different key and is still delivered.
 *
 * The guarantee is bounded by retention: while the record is in the mailbox (new,
 * cur or the dead-letter queue) or its acceptance receipt is unexpired, a resend
 * creates no additional inbox record. A recognised resend keeps the record's file
 * name and id; when the match is in a mailbox root that acceptance holds for
 * writing (the recipient's own always is), its receivedAt is refreshed, and a
 * match in a root scanned read-only is returned without that rewrite. After a
 * local ACK has removed the record, a matching receipt means no record is
 * written at all. Once both the record and the receipt are gone, a resend is
 * eligible for a new delivery attempt, and the ordinary inbox and dead-letter
 * paths apply to it.
 *
 * A keyed record that does not parse as a mail record is refused: no ACK, no
 * quarantine, no replacement. The lost-ACK case (the ACK is sent and never
 * reaches the sender, which resends) is in relay-delivery-loss.test.ts, where
 * the branch's real outbox does the resend.
 *
 * `syncRemoteBranch` receives MAIL_DELIVER frames over a stubbed channel and ACKs
 * them; `deliverRelayedToLocal` is the acceptance entry point the receiver uses.
 */
import { afterEach, beforeEach, describe, expect, spyOn, mock, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ackMessageAtPath, getInbox, RelayedRecordInvalidError, relayRecordFileName, sendMessage } from "../src/utils/mail.js";
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

  test("a marker write failure withholds the ACK and removes the record; the resend of the same id yields one record and an ACK", async () => {
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

  test("after a crash between the inbox write and the marker write, the resend creates no additional inbox record", () => {
    const body = mailBody();
    // The inbox write happened (the real relay record), the marker write did not.
    sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
    expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
    expect(deliverRelayedToLocal("remote", body)).toBe(false);
    expect(newRecords()).toHaveLength(1);
  });

  test("a resend is matched to the keyed record by its name, not by the record's relay fields", () => {
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
  for (const location of ["new", "cur", "dlq"] as const) {
    test(`a keyed ${location} record that does not parse refuses the resend: no ACK, no quarantine, no replacement`, async () => {
      const body = mailBody();
      const placed = sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
      const inbox = getInbox("local");
      const dir = location === "new" ? inbox.fresh : inbox[location];
      const keyed = join(dir, relayRecordFileName("remote", body.id));
      const malformed = JSON.stringify({ ...JSON.parse(fs.readFileSync(placed.filePath, "utf8")), relayDelivery: null });
      fs.rmSync(placed.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyed, malformed);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await receive(body);
      expect(acks).toEqual([]);
      expect(() => deliverRelayedToLocal("remote", body)).toThrow(RelayedRecordInvalidError);
      expect(fs.readFileSync(keyed, "utf8")).toBe(malformed);
      for (const other of [inbox.fresh, inbox.cur, inbox.dlq, join(inbox.root, "quarantine")]) {
        const files = fs.existsSync(other) ? fs.readdirSync(other).filter((f) => f.endsWith(".json")) : [];
        expect(files).toEqual(other === dir ? [basename(keyed)] : []);
      }
      expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
      expect(errors.mock.calls.flat().join("\n")).toContain(`relayed record ${keyed} for branch remote message ${body.id} does not parse as a mail record; delivery refused without ACK`);
    }, 20_000);
  }

  test("the window: the record holds it past receipt expiry; once the record is acknowledged and the receipt expired, the resend is a new delivery attempt", () => {
    const body = mailBody();
    expect(deliverRelayedToLocal("remote", body)).toBe(true);
    const keyed = relayRecordFileName("remote", body.id);
    const marker = relayAcceptanceReceiptPath("remote", body.id);
    const expireReceipt = () => {
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(marker, old, old);
    };
    process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS = "1000";
    try {
      // Receipt expired, record still in the mailbox: inside the window.
      expireReceipt();
      expect(deliverRelayedToLocal("remote", body)).toBe(false);
      expect(newRecords()).toEqual([keyed]);
      // Record acknowledged (removed) and receipt expired: the window has closed.
      ackMessageAtPath(join(getInbox("local").fresh, keyed));
      expect(newRecords()).toEqual([]);
      expireReceipt();
      expect(deliverRelayedToLocal("remote", body)).toBe(true);
      expect(newRecords()).toEqual([keyed]);
    } finally {
      delete process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS;
    }
  });
});
