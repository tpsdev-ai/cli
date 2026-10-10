import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { MailClient, hasCommittedMessageId } from "@tpsdev-ai/agent";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gcMessages, getInbox, MAX_INBOX_MESSAGES, sendMessage, ackMessageAtPath } from "../src/utils/mail.js";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { runMail } from "../src/commands/mail.js";
import { RELAY_ACCEPT_LOCK_STRIPES, syncRemoteBranch, connectAndKeepAlive, deliverRelayedToLocal, relayAcceptanceReceiptPath, pruneRelayAcceptanceReceipts } from "../src/utils/relay.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import { generateKeyPair, initHostIdentity, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import { drainOutbox, OUTBOX_RESEND_BASE_MS, queueOutboxMessage } from "../src/utils/outbox.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, MSG_HEARTBEAT, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { writeKeyFile, buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const SEEDS = { remote: Buffer.alloc(32, 0x11), local: Buffer.alloc(32, 0x22) };

for (const entry of ["sync", "connect"] as const) {
  describe(`${entry} relayed local delivery retention`, () => {
    let root: string;
    let savedEnv: Record<string, string | undefined>;
    let stop: (() => Promise<void>) | undefined;
    let completion: Promise<unknown> | undefined;
    let handlers: Set<(msg: TpsMessage) => void>;
    let acks: TpsMessage[];
    let channel: TransportChannel;
    let branchReceive: (msg: TpsMessage, channel: TransportChannel) => void | Promise<void>;
    let branchChannel: TransportChannel;
    let signalListeners: Map<"SIGTERM" | "SIGINT", Set<(...args: any[]) => void>>;

    beforeEach(async () => {
      root = fs.mkdtempSync(join(tmpdir(), "tps-relay-loss-"));
      savedEnv = {};
      for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_ROOT"]) savedEnv[k] = process.env[k];
      process.env.HOME = root;
      process.env.TPS_ROOT = root;
      process.env.TPS_BRANCH_NO_DAEMON = "1";
      process.env.TPS_MAIL_DIR = join(root, "mail");
      process.env.TPS_IDENTITY_DIR = join(root, "identity");
      process.env.TPS_REGISTRY_DIR = join(root, "registry");
      process.env.TPS_VAULT_KEY = "relay-test";
      process.env.FLAIR_URL = "http://flair.invalid";
      process.env.FLAIR_KEY_PATH = writeKeyFile(join(root, "keys"), "local", SEEDS.local);
      spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const name = new URL(String(input)).pathname.match(/^\/Agent\/(.+)$/)?.[1];
        const seed = name && SEEDS[name as keyof typeof SEEDS];
        return seed ? Response.json({ id: name, name, publicKey: pubkeyFromSeed(seed).toString("base64") }) : new Response("not found", { status: 404 });
      });
      await initHostIdentity();
      const kp = generateKeyPair();
      registerBranch("remote", kp.signing.publicKey, undefined, kp.encryption.publicKey);
      const branchDir = join(root, ".tps", "branch-office", "remote");
      fs.mkdirSync(branchDir, { recursive: true });
      fs.writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
      handlers = new Set();
      acks = [];
      let alive = true;
      channel = {
        async send(msg) {
          if (msg.type === MSG_MAIL_ACK) {
            acks.push(msg);
            await branchReceive(msg, branchChannel);
          }
        },
        onMessage(handler) { handlers.add(handler); },
        offMessage(handler) { handlers.delete(handler); },
        async close() { alive = false; },
        isAlive() { return alive; },
        peerFingerprint() { return "remote"; },
      };
      spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
      saveKeyPair(kp, process.env.TPS_IDENTITY_DIR!, "branch");
      fs.writeFileSync(join(process.env.TPS_IDENTITY_DIR!, "host.json"), JSON.stringify({ publicKey: Buffer.from(kp.encryption.publicKey).toString("base64url") }));
      writeBranchConf(1, "unused", "ws", undefined, "remote");
      branchChannel = { ...channel, async send(msg) {
        if (msg.type === MSG_MAIL_DELIVER) {
          for (const handler of handlers) handler(msg);
          await Bun.sleep(0);
        }
      } };
      spyOn(ws, "listenForHostWs").mockImplementation(async (_kp, _host, _port, handler) => {
        branchReceive = handler;
        return { onConnection() {}, async close() {} };
      });
      spyOn(fs, "watch").mockReturnValue({ close() {} } as fs.FSWatcher);
      signalListeners = new Map(["SIGTERM", "SIGINT"].map((signal) => [signal as "SIGTERM" | "SIGINT", new Set(process.listeners(signal))]));
      void runBranch({ action: "start" });
      expect(branchReceive!).toBeDefined();
      stop = undefined;
      completion = undefined;
    });

    afterEach(async () => {
      if (stop) await stop();
      if (completion) await completion;
      if (entry === "connect") await Bun.sleep(1100);
      for (const [signal, before] of signalListeners) {
        for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
      }
      mock.restore();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    function jsonFiles(dir: string): string[] {
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    }

    function fillInbox(): void {
      for (let i = 0; i < MAX_INBOX_MESSAGES; i++) sendMessage("local", `filler-${i}`, "seeder");
      expect(jsonFiles(getInbox("local").fresh).length).toBe(MAX_INBOX_MESSAGES);
    }

    function queue(content: string): MailDeliverBody {
      const before = new Set(drainOutbox(false).map((m) => m.id));
      queueOutboxMessage("local", content, "remote");
      const item = drainOutbox(false).find((m) => !before.has(m.id))!;
      return { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp };
    }

    async function start(): Promise<void> {
      if (entry === "sync") completion = syncRemoteBranch("remote");
      else stop = await connectAndKeepAlive("remote");
      for (let i = 0; handlers.size === 0 && i < 100; i++) await Bun.sleep(10);
      expect(handlers.size).toBeGreaterThan(0);
    }

    async function emit(): Promise<void> {
      await branchReceive({ type: MSG_HEARTBEAT, seq: 1, ts: new Date().toISOString(), body: {} }, branchChannel);
      await Bun.sleep(0);
    }

    test("retains an over-cap message and mail check refuses tampered and wrong-recipient envelopes", async () => {
      fillInbox();
      const valid = buildSignedEnvelope("remote", "local", "relayed reply", SEEDS);
      const tampered = { ...buildSignedEnvelope("remote", "local", "original", SEEDS), body: "tampered" };
      const wrong = buildSignedEnvelope("remote", "other", "wrong recipient", SEEDS);
      const bodies = [valid, tampered, wrong].map((env) => queue(JSON.stringify(env)));
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      await emit();
      const inbox = getInbox("local");
      expect(jsonFiles(inbox.dlq).length).toBe(3);
      for (const file of jsonFiles(inbox.dlq)) expect(fs.readFileSync(join(inbox.dlq, `${file}.reason`), "utf8")).toContain("class: inbox-full");
      expect(acks.length).toBe(3);
      expect(drainOutbox(false)).toEqual([]);
      const logs = errors.mock.calls.flat().join("\n");
      for (const body of bodies) expect(logs).toContain(body.id);
      expect(logs).toContain("local");
      expect(logs).toContain("Inbox full");
      const output = spyOn(console, "log").mockImplementation(() => {});
      await runMail({ action: "check", agent: "local", json: true });
      const delivered = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(delivered.map((m: { envelopeId: string }) => m.envelopeId)).toEqual([valid.messageId]);
      expect(delivered[0].body).toBe("relayed reply");
      expect(jsonFiles(inbox.fresh)).toEqual([]);
      expect(jsonFiles(inbox.cur).length).toBe(1);
      const rejected = jsonFiles(inbox.dlq).map((f) => JSON.parse(fs.readFileSync(join(inbox.dlq, f), "utf8")));
      expect(rejected.some((r) => r.id === bodies[1]!.id)).toBe(true);
      expect(rejected.some((r) => r.id === bodies[2]!.id)).toBe(true);
    });

    for (const fault of ["sidecar", "record", "publish-throws"] as const) {
      test(`${fault} failure leaves the branch source unacked and retryable`, async () => {
        fillInbox();
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "retry me", SEEDS)));
        const inbox = getInbox("local");
        const errors = spyOn(console, "error").mockImplementation(() => {});
        await start();
        const write = fs.writeFileSync;
        const rename = fs.renameSync;
        const injected = fault === "publish-throws"
          ? spyOn(fs, "renameSync").mockImplementation((src, dst) => {
            if (String(dst).startsWith(inbox.dlq)) throw new Error("simulated publish failure");
            return rename(src, dst);
          })
          : spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
            if ((fault === "sidecar" && String(path).endsWith(".reason")) || (fault === "record" && String(path).startsWith(inbox.tmp))) throw new Error(`injected ${fault} write failure`);
            return write(path, data, opts);
          });
        try { await emit(); } finally { injected.mockRestore(); }
        expect(acks).toEqual([]);
        expect(drainOutbox(false).map((m) => m.id)).toEqual([body.id]);
        expect(jsonFiles(inbox.dlq)).toEqual([]);
        if (fault === "publish-throws") expect(fs.readdirSync(inbox.dlq).some((f) => f.endsWith(".reason"))).toBe(false);
        const logs = errors.mock.calls.flat().join("\n");
        expect(logs).toContain(body.id);
        expect(logs).toContain("local");
        expect(logs).toContain("relay dead-letter failed; retry delivery");
        await emit();
        expect(acks).toEqual([]);
        const later = Date.now() + OUTBOX_RESEND_BASE_MS;
        const clock = spyOn(Date, "now").mockReturnValue(later);
        try { await emit(); } finally { clock.mockRestore(); }
        expect(acks.length).toBe(1);
        expect(drainOutbox(false)).toEqual([]);
        expect(jsonFiles(inbox.dlq).length).toBe(1);
      });
    }

    test("a local write failure leaves the source unacked and its resend delivers once", async () => {
      const env = buildSignedEnvelope("remote", "local", "write fault", SEEDS);
      queue(JSON.stringify(env));
      const inbox = getInbox("local");
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      const write = fs.writeFileSync;
      let failed = false;
      const injected = spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
        if (!failed && String(path).startsWith(inbox.tmp)) {
          failed = true;
          throw new Error("injected transient write failure");
        }
        return write(path, data, opts);
      });
      try { await emit(); } finally { injected.mockRestore(); }
      expect(failed).toBe(true);
      expect(acks).toEqual([]);
      expect(drainOutbox(false)).toHaveLength(1);
      expect(jsonFiles(inbox.dlq)).toEqual([]);
      expect(jsonFiles(inbox.cur)).toEqual([]);
      const later = Date.now() + OUTBOX_RESEND_BASE_MS;
      const clock = spyOn(Date, "now").mockReturnValue(later);
      try { await emit(); } finally { clock.mockRestore(); }
      expect(acks).toHaveLength(1);
      expect(drainOutbox(false)).toEqual([]);
      expect(jsonFiles(inbox.fresh)).toHaveLength(1);
      const output = spyOn(console, "log").mockImplementation(() => {});
      await runMail({ action: "check", agent: "local", json: true });
      const delivered = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(delivered.map((m: { envelopeId: string }) => m.envelopeId)).toEqual([env.messageId]);
      expect(delivered[0].body).toBe("write fault");
    });

    test("a replayed delivery is acknowledged without a second inbox record", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "once", SEEDS)));
      await start();
      const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
      for (const handler of handlers) handler(msg);
      await Bun.sleep(0);
      for (const handler of handlers) handler(msg);
      await Bun.sleep(0);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(acks.length).toBe(2);
    });

    async function deliverDirect(msg: TpsMessage): Promise<void> {
      for (const handler of handlers) handler(msg);
      await Bun.sleep(0);
    }

    test("a changed promoted record conflicts with its original delivery without ACK", async () => {
      const inbox = getInbox("local");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      for (const field of ["from", "to", "body", "timestamp", "envelope"] as const) {
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", `projection ${field}`, SEEDS)));
        deliverRelayedToLocal("remote", body);
        const output = spyOn(console, "log").mockImplementation(() => {});
        await runMail({ action: "check", agent: "local", json: true });
        expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toHaveLength(1);
        output.mockRestore();
        const [file] = jsonFiles(inbox.cur).filter((name) => JSON.parse(fs.readFileSync(join(inbox.cur, name), "utf8")).relayDelivery?.id === body.id);
        const source = join(inbox.cur, file);
        const record = JSON.parse(fs.readFileSync(source, "utf8"));
        const changed = field === "envelope" ? { ...record, envelope: buildSignedEnvelope("remote", "local", "changed", SEEDS), body: "changed" } : { ...record, [field]: field === "timestamp" ? new Date(0).toISOString() : "other" };
        const before = JSON.stringify(changed);
        fs.writeFileSync(source, before);
        await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
        expect(acks).toEqual([]);
        expect(fs.readFileSync(source, "utf8")).toBe(before);
        expect(drainOutbox(false).map((item) => item.id)).toContain(body.id);
        expect(errors.mock.calls.flat().join("\n")).toContain("conflict");
      }
    });

    test("invalid record field values are quarantined before ACK", async () => {
      const inbox = getInbox("local");
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      for (const field of ["id", "from", "to", "body", "timestamp", "read", "relayDelivery", "relayPayload", "receivedAt"] as const) {
        const body = queue(`invalid ${field}`);
        const valid = { id: randomUUID(), from: body.from, to: body.to, body: body.content, timestamp: body.timestamp, read: false, relayDelivery: { branchId: "remote", id: body.id } };
        const invalid = JSON.stringify({ ...valid, [field]: null });
        const source = join(inbox.fresh, `invalid-${field}.json`);
        fs.writeFileSync(source, invalid);
        const send = channel.send;
        channel.send = async (ack) => {
          if (ack.type === MSG_MAIL_ACK) {
            const copies = jsonFiles(join(inbox.root, "quarantine")).map((file) => fs.readFileSync(join(inbox.root, "quarantine", file), "utf8"));
            expect(copies).toContain(invalid);
            const records = jsonFiles(inbox.fresh).map((file) => JSON.parse(fs.readFileSync(join(inbox.fresh, file), "utf8")));
            expect(records.find((record) => record.relayDelivery?.id === body.id)).toMatchObject({ from: body.from, to: body.to, body: body.content, timestamp: body.timestamp, read: false });
          }
          return send(ack);
        };
        try { await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body }); }
        finally { channel.send = send; }
        expect(acks.at(-1)!.body).toEqual({ id: body.id, accepted: true });
        expect(drainOutbox(false)).toEqual([]);
      }
    });

    for (const location of ["new", "cur", "dlq"] as const) {
      test(`an incomplete ${location} record is quarantined before publication and unchanged resend ACK`, async () => {
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "incomplete candidate", SEEDS)));
        const inbox = getInbox("local");
        const dir = location === "new" ? inbox.fresh : inbox[location];
        const source = join(dir, "incomplete.json");
        const incomplete = JSON.stringify({ relayDelivery: { branchId: "remote", id: body.id } });
        fs.writeFileSync(source, incomplete);
        const errors = spyOn(console, "error").mockImplementation(() => {});
        await start();
        const send = channel.send;
        const atAck: string[] = [];
        channel.send = async (ack) => {
          if (ack.type === MSG_MAIL_ACK && (ack.body as { id: string }).id === body.id) {
            const [file] = jsonFiles(inbox.fresh);
            atAck.push(fs.readFileSync(join(inbox.fresh, file), "utf8"));
            const [quarantined] = jsonFiles(join(inbox.root, "quarantine"));
            expect(fs.readFileSync(join(inbox.root, "quarantine", quarantined), "utf8")).toBe(incomplete);
          }
          return send(ack);
        };
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
        await deliverDirect(msg);
        await deliverDirect(msg);
        expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }, { id: body.id, accepted: true }]);
        expect(atAck).toHaveLength(2);
        for (const raw of atAck) expect(JSON.parse(raw)).toMatchObject({ from: body.from, to: body.to, body: body.content, timestamp: body.timestamp, read: false });
        expect(jsonFiles(inbox.fresh)).toHaveLength(1);
        expect(drainOutbox(false)).toEqual([]);
        const [quarantined] = jsonFiles(join(inbox.root, "quarantine"));
        expect(fs.readFileSync(join(inbox.root, "quarantine", `${quarantined}.reason`), "utf8")).toContain("class: invalid");
        expect(errors.mock.calls.flat().join("\n")).toContain(source);
        const next = { ...body, id: randomUUID(), content: "separate delivery" };
        await deliverDirect({ ...msg, body: next });
        expect(acks.at(-1)!.body).toEqual({ id: next.id, accepted: true });
        expect(jsonFiles(inbox.fresh)).toHaveLength(2);
      });

    }

    for (const location of ["new", "cur", "dlq", "promoted"] as const) {
      for (const field of ["from", "to", "content", "timestamp"] as const) {
        test(`a same-ID resend with different ${field} conflicts with ${location} without ACK`, async () => {
          const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "original payload", SEEDS)));
          const inbox = getInbox("local");
          if (location === "dlq") fillInbox();
          deliverRelayedToLocal("remote", body);
          if (location === "cur") {
            const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, "local", {
              async getAgent(id) { const seed = SEEDS[id as keyof typeof SEEDS]; return seed ? { publicKey: pubkeyFromSeed(seed) } : null; },
            });
            expect(await client.checkNewMail()).toHaveLength(1);
          }
          if (location === "promoted") {
            const output = spyOn(console, "log").mockImplementation(() => {});
            await runMail({ action: "check", agent: "local", json: true });
            expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toHaveLength(1);
            output.mockRestore();
          }
          const dir = location === "new" ? inbox.fresh : location === "promoted" ? inbox.cur : inbox[location];
          const [file] = jsonFiles(dir).filter((name) => JSON.parse(fs.readFileSync(join(dir, name), "utf8")).relayDelivery?.id === body.id);
          const source = join(dir, file);
          const before = fs.readFileSync(source, "utf8");
          const marker = relayAcceptanceReceiptPath("remote", body.id);
          const beforeMarker = fs.readFileSync(marker, "utf8");
          const errors = spyOn(console, "error").mockImplementation(() => {});
          await start();
          const changed = { ...body, [field]: field === "timestamp" ? new Date(0).toISOString() : field === "content" ? "changed payload" : "other" };
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: changed });
          expect(acks).toEqual([]);
          expect(fs.readFileSync(source, "utf8")).toBe(before);
          expect(fs.readFileSync(marker, "utf8")).toBe(beforeMarker);
          expect(jsonFiles(dir)).toHaveLength(1);
          expect(jsonFiles(join(process.env.TPS_MAIL_DIR!, "other", "new"))).toEqual([]);
          expect(drainOutbox(false).map((item) => item.id)).toEqual([body.id]);
          const logs = errors.mock.calls.flat().join("\n");
          expect(logs).toContain("conflict");
          expect(logs).toContain(body.id);
          expect(logs).not.toContain("changed payload");
          fs.rmSync(marker);
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body: changed });
          expect(acks).toEqual([]);
          expect(fs.readFileSync(source, "utf8")).toBe(before);
          expect(fs.readdirSync(join(marker, ".."))).not.toContain(body.id);
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 3, ts: new Date().toISOString(), body });
          expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
          expect(jsonFiles(dir)).toHaveLength(1);
          expect(drainOutbox(false)).toEqual([]);
        });
      }
    }

    for (const destination of ["inbox", "DLQ", "cur"] as const) {
      for (const prior of ["none", "marker", "no-marker"] as const) {
        test(`${destination} ${prior} receipt survives GC at ACK with an old sender timestamp`, async () => {
          if (destination === "DLQ") fillInbox();
          const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "old timestamp", SEEDS)));
          body.timestamp = new Date(0).toISOString();
          const inbox = getInbox("local");
          const dir = destination === "DLQ" ? inbox.dlq : destination === "cur" ? inbox.cur : inbox.fresh;
          spyOn(console, "error").mockImplementation(() => {});
          if (prior !== "none") {
            deliverRelayedToLocal("remote", body);
            const initialDir = destination === "DLQ" ? inbox.dlq : inbox.fresh;
            const [file] = jsonFiles(initialDir).filter((file) => JSON.parse(fs.readFileSync(join(initialDir, file), "utf8")).relayDelivery?.id === body.id);
            const record = JSON.parse(fs.readFileSync(join(initialDir, file), "utf8"));
            record.receivedAt = body.timestamp;
            if (destination === "cur") { record.read = true; record.ackedAt = body.timestamp; }
            fs.writeFileSync(join(initialDir, file), JSON.stringify(record));
            if (destination === "cur") fs.renameSync(join(initialDir, file), join(inbox.cur, file));
            if (prior === "no-marker") fs.rmSync(relayAcceptanceReceiptPath("remote", body.id));
          }
          fs.writeFileSync(join(inbox.dlq, "expired-canary.json"), JSON.stringify({ id: "expired", from: "remote", to: "local", body: "expired", timestamp: body.timestamp, read: false }));
          await start();
          const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, "local", {
            async getAgent(id) {
              const seed = SEEDS[id as keyof typeof SEEDS];
              return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
            },
          });
          const send = channel.send;
          let gcAtAck: number | undefined;
          let recordAtAck: { timestamp: string; receivedAt: string } | undefined;
          channel.send = async (ack) => {
            if (ack.type === MSG_MAIL_ACK) {
              if (destination === "cur" && prior === "none") expect(await client.checkNewMail()).toHaveLength(1);
              gcAtAck = gcMessages("local");
              recordAtAck = jsonFiles(dir).map((file) => JSON.parse(fs.readFileSync(join(dir, file), "utf8"))).find((record) => record.relayDelivery?.id === body.id);
            }
            return send(ack);
          };
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
          for (let i = 0; acks.length === 0 && i < 100; i++) await Bun.sleep(10);
          expect(gcAtAck).toBe(1);
          expect(recordAtAck).toBeDefined();
          if (destination !== "cur" || prior !== "none") expect(recordAtAck!.timestamp).toBe(body.timestamp);
          expect(Date.parse(recordAtAck!.receivedAt)).toBeGreaterThan(Date.now() - 10_000);
          expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
          expect(gcMessages("local")).toBe(0);
          expect(jsonFiles(dir)).toHaveLength(1);
          expect(drainOutbox(false)).toEqual([]);
        });
      }
    }

    test("receipt failure removes the new record before redelivery", async () => {
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "accept once", SEEDS)));
        const inbox = getInbox("local");
        const marker = relayAcceptanceReceiptPath("remote", body.id);
        fs.mkdirSync(`${marker}.tmp`, { recursive: true });
        spyOn(console, "error").mockImplementation(() => {});
        await start();
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
        await deliverDirect(msg);
        expect(acks).toEqual([]);
        expect(jsonFiles(inbox.fresh)).toEqual([]);
        expect(fs.existsSync(marker)).toBe(false);
        expect(drainOutbox(false).map((m) => m.id)).toEqual([body.id]);
        fs.rmSync(`${marker}.tmp`, { recursive: true, force: true });
        await deliverDirect(msg);
        expect(acks.map((ack) => (ack.body as { id: string }).id)).toEqual([body.id]);
        expect(jsonFiles(inbox.fresh).length + jsonFiles(inbox.cur).length).toBe(1);
        expect(drainOutbox(false)).toEqual([]);
      });

    test("ACK failure then redelivery keeps one inbox record", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "ACK retry", SEEDS)));
      const marker = relayAcceptanceReceiptPath("remote", body.id);
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
      const send = channel.send;
      channel.send = async (ack) => {
        if (ack.type === MSG_MAIL_ACK) throw new Error("injected ACK failure");
        return send(ack);
      };
      await deliverDirect(msg);
      expect(fs.existsSync(marker)).toBe(true);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(acks).toEqual([]);
      channel.send = send;
      await deliverDirect(msg);
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });

    async function ackOnlyRecord(): Promise<void> {
      const inbox = getInbox("local");
      const [file] = jsonFiles(inbox.fresh);
      ackMessageAtPath(join(inbox.fresh, file));
      expect(jsonFiles(inbox.fresh)).toEqual([]);
    }

    test("an identical resend after ACK is a duplicate: one record, no second delivered", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "once", SEEDS)));
      await start();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
      expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
      await ackOnlyRecord();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body });
      expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }, { id: body.id, accepted: true }]);
      expect(jsonFiles(getInbox("local").fresh)).toEqual([]);
      expect(jsonFiles(getInbox("local").cur)).toEqual([]);
      expect(drainOutbox(false)).toEqual([]);
    });

    test("a differing resend after ACK is refused without a second delivery", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "once", SEEDS)));
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
      await ackOnlyRecord();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body: { ...body, content: "changed payload" } });
      expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
      expect(jsonFiles(getInbox("local").fresh)).toEqual([]);
      expect(jsonFiles(getInbox("local").dlq)).toEqual([]);
      expect(errors.mock.calls.flat().join("\n")).toContain("conflict");
    });

    test("a flat per-branch marker from before receipts refuses resend after local ACK without ACK", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "legacy acceptance", SEEDS)));
      const original = sendMessage("local", body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
      const marker = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote", body.id);
      fs.mkdirSync(join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote"), { recursive: true });
      fs.writeFileSync(marker, "");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      ackMessageAtPath(original.filePath);
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body });
      expect(jsonFiles(getInbox("local").fresh)).toEqual([]);
      expect(jsonFiles(getInbox("local").dlq)).toEqual([]);
      expect(acks).toEqual([]);
      expect(drainOutbox(false).map((item) => item.id)).toContain(body.id);
      expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
      expect(errors.mock.calls.flat().join("\n")).toContain(`relayed delivery conflict for branch remote message ${body.id}: accepted before receipts existed; payload cannot be compared; sender must not retry`);
    });

    test("a receipt older than the prune bound no longer blocks a resend", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "late", SEEDS)));
      await start();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
      await ackOnlyRecord();
      const marker = relayAcceptanceReceiptPath("remote", body.id);
      process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS = "1000";
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(marker, old, old);
      try {
        await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body });
      } finally {
        delete process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS;
      }
      expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }, { id: body.id, accepted: true }]);
      expect(jsonFiles(getInbox("local").fresh)).toHaveLength(1);
    });

    test("a whole old receipt bucket is removed when a new receipt is written", async () => {
      const first = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "first accepted", SEEDS)));
      await start();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: first });
      const accepted = join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote");
      const firstMarker = relayAcceptanceReceiptPath("remote", first.id);
      expect(fs.existsSync(firstMarker)).toBe(true);
      process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS = "1000";
      const oldBucket = join(accepted, "2020-01-01");
      fs.mkdirSync(oldBucket);
      fs.renameSync(firstMarker, join(oldBucket, first.id));
      const second = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "second accepted", SEEDS)));
      try {
        await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body: second });
      } finally {
        delete process.env.TPS_RELAY_ACCEPT_RECEIPT_TTL_MS;
      }
      expect(fs.existsSync(oldBucket)).toBe(false);
      expect(fs.existsSync(relayAcceptanceReceiptPath("remote", second.id))).toBe(true);
      expect(jsonFiles(getInbox("local").fresh)).toHaveLength(2);
    });

    test("a marker read failure refuses the delivery without an ACK", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "marker read", SEEDS)));
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
      await ackOnlyRecord();
      const marker = relayAcceptanceReceiptPath("remote", body.id);
      const read = fs.readFileSync;
      const fault = spyOn(fs, "readFileSync").mockImplementation((path, options) => {
        if (String(path) === marker) throw Object.assign(new Error("injected marker read denied"), { code: "EACCES" });
        return read(path, options as BufferEncoding);
      });
      try {
        await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body });
      } finally {
        fault.mockRestore();
      }
      expect(acks.length).toBe(1);
      expect(jsonFiles(getInbox("local").fresh)).toEqual([]);
      expect(errors.mock.calls.flat().join("\n")).toContain("injected marker read denied");
    });

    for (const state of ["removed-unread", "consumed"] as const) {
      test(`an existing ${state} receipt with no record dedups an identical resend and is ACKed`, async () => {
        const envelope = buildSignedEnvelope("remote", "local", state, SEEDS);
        const body = queue(JSON.stringify(envelope));
        const inbox = getInbox("local");
        const marker = relayAcceptanceReceiptPath("remote", body.id);
        const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, "local", {
          async getAgent(id) {
            const seed = SEEDS[id as keyof typeof SEEDS];
            return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
          },
        });
        spyOn(console, "error").mockImplementation(() => {});
        await start();
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
        const send = channel.send;
        channel.send = async () => { throw new Error("injected lost ACK"); };
        await deliverDirect(msg);
        channel.send = send;
        expect(acks).toEqual([]);
        expect(jsonFiles(inbox.fresh)).toHaveLength(1);
        if (state === "consumed") {
          expect(await client.checkNewMail()).toHaveLength(1);
          expect(hasCommittedMessageId(join(process.env.TPS_MAIL_DIR!, "local"), envelope.messageId)).toBe(true);
        }
        const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
        try { expect(gcMessages("local", "24h", undefined, "1s")).toBe(1); }
        finally { clock.mockRestore(); }
        expect(jsonFiles(inbox.fresh)).toEqual([]);
        expect(jsonFiles(inbox.cur)).toEqual([]);

        const recordsAtAck: number[] = [];
        const ackSend = channel.send;
        channel.send = async (ack) => {
          if (ack.type === MSG_MAIL_ACK) recordsAtAck.push(jsonFiles(inbox.fresh).length);
          return ackSend(ack);
        };
        await deliverDirect(msg);
        expect(recordsAtAck).toEqual([0]);
        expect(jsonFiles(inbox.fresh)).toEqual([]);
        expect(jsonFiles(inbox.cur)).toEqual([]);
        expect(jsonFiles(inbox.dlq)).toEqual([]);
        expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
        expect(drainOutbox(false)).toEqual([]);
        expect(await client.checkNewMail()).toEqual([]);
        expect(fs.existsSync(marker)).toBe(true);
      });
    }

    test("an empty pre-receipt marker with no record refuses without an ACK", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "legacy", SEEDS)));
      const inbox = getInbox("local");
      const legacy = join(process.env.TPS_MAIL_DIR!, ".relay-accepted");
      const marker = join(legacy, body.id);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(marker, "");
      await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
      expect(acks).toEqual([]);
      expect(errors.mock.calls.flat().join("\n")).toContain("conflict");
      expect(jsonFiles(inbox.fresh)).toEqual([]);
      expect(jsonFiles(inbox.cur)).toEqual([]);
      expect(jsonFiles(inbox.dlq)).toEqual([]);
      expect(drainOutbox(false).map((item) => item.id)).toEqual([body.id]);
      expect(fs.readFileSync(marker, "utf8")).toBe("");
    });

    for (const signature of ["valid", "invalid"] as const) {
      test(`a delivery whose envelope reuses a consumed message id is refused at promotion (${signature} signature)`, async () => {
        const original = buildSignedEnvelope("remote", "local", "unrelated", SEEDS);
        sendMessage("local", JSON.stringify(original), "remote");
        const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, "local", {
          async getAgent(id) {
            const seed = SEEDS[id as keyof typeof SEEDS];
            return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
          },
        });
        expect(await client.checkNewMail()).toHaveLength(1);
        const envelope = buildSignedEnvelope("remote", "local", "different delivery", SEEDS, { messageId: original.messageId });
        if (signature === "invalid") envelope.body = "tampered";
        const body = queue(JSON.stringify(envelope));
        const inbox = getInbox("local");
        spyOn(console, "error").mockImplementation(() => {});
        await start();
        await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body });
        expect(acks.map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
        expect(drainOutbox(false)).toEqual([]);
        expect(await client.checkNewMail()).toEqual([]);
        const [file] = jsonFiles(inbox.dlq);
        expect(fs.readFileSync(join(inbox.dlq, `${file}.reason`), "utf8")).toContain(`class: ${signature === "valid" ? "replay" : "invalid"}`);
      });
    }

    for (const dir of ["new", "cur", "dlq"] as const) {
      test(`an unreadable matching ${dir} record refuses host acceptance without an ACK`, async () => {
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "read retry", SEEDS)));
        const inbox = getInbox("local");
        const record = sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
        const source = join(inbox.root, dir, record.filePath.split("/").at(-1)!);
        if (dir !== "new") fs.renameSync(record.filePath, source);
        const before = fs.readFileSync(source, "utf8");
        const errors = spyOn(console, "error").mockImplementation(() => {});
        await start();
        const read = fs.readFileSync;
        const fault = spyOn(fs, "readFileSync").mockImplementation((path, options) => {
          if (String(path) === source) throw Object.assign(new Error("injected read denied"), { code: "EACCES" });
          return read(path, options as BufferEncoding);
        });
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
        try { await deliverDirect(msg); } finally { fault.mockRestore(); }
        expect(acks).toEqual([]);
        expect(fs.readFileSync(source, "utf8")).toBe(before);
        expect(jsonFiles(inbox.fresh).length + jsonFiles(inbox.cur).length + jsonFiles(inbox.dlq).length).toBe(1);
        expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
        expect(errors.mock.calls.flat().join("\n")).toContain(`relayed record read failed: ${source}`);
        expect(drainOutbox(false).map((item) => item.id)).toContain(body.id);
        if (dir === "dlq") fs.writeFileSync(`${source}.reason`, "class: inbox-full\n");
        await deliverDirect(msg);
        expect(acks).toHaveLength(1);
        expect(drainOutbox(false)).toEqual([]);
        expect(jsonFiles(inbox.fresh).length + jsonFiles(inbox.cur).length + jsonFiles(inbox.dlq).length).toBe(1);
      });
    }

    test("inbox and DLQ write failures leave no marker or ACK, then retry writes one record", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "write retry", SEEDS)));
      const inbox = getInbox("local");
      const marker = relayAcceptanceReceiptPath("remote", body.id);
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
      const write = fs.writeFileSync;
      const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
        if (String(path).startsWith(inbox.tmp) && String(path).endsWith(".json")) fs.mkdirSync(String(path));
        return write(path, data, opts);
      });
      try { await deliverDirect(msg); } finally { fault.mockRestore(); }
      expect(acks).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
      expect(jsonFiles(inbox.fresh)).toEqual([]);
      expect(jsonFiles(inbox.dlq)).toEqual([]);
      for (const dir of fs.readdirSync(inbox.tmp)) fs.rmSync(join(inbox.tmp, dir), { recursive: true });
      await deliverDirect(msg);
      expect(jsonFiles(inbox.fresh).length).toBe(1);
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });

    for (const destination of ["inbox", "DLQ"] as const) {
      test(`${destination} and marker fsync failures send no ACK at each sync call`, async () => {
        if (destination === "DLQ") fillInbox();
        const inbox = getInbox("local");
        spyOn(console, "error").mockImplementation(() => {});
        await start();
        fs.mkdirSync(join(process.env.TPS_MAIL_DIR!, ".relay-accepted", "by-branch", "remote"), { recursive: true });
        for (let stripe = 0; stripe < RELAY_ACCEPT_LOCK_STRIPES; stripe++) {
          fs.mkdirSync(join(process.env.TPS_MAIL_DIR!, ".relay-accept-locks", String(stripe)), { recursive: true });
        }
        const sync = fs.fsyncSync;
        const trace: number[] = [];
        const capture = spyOn(fs, "fsyncSync").mockImplementation((fd) => { trace.push(fd); return sync(fd); });
        const initial = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "sync trace", SEEDS)));
        try {
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: initial });
          trace.length = 0;
          const warmed = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "warmed sync trace", SEEDS)));
          await deliverDirect({ type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body: warmed });
        }
        finally { capture.mockRestore(); }
        expect(acks.length).toBe(2);
        expect(trace.length).toBeGreaterThanOrEqual(destination === "inbox" ? 4 : 5);
        for (let step = 1; step <= trace.length; step++) {
          const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", `sync fault ${step}`, SEEDS)));
          const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: step + 1, ts: new Date().toISOString(), body };
          const beforeAcks = acks.length;
          const beforeRecords = jsonFiles(inbox.fresh).length + jsonFiles(inbox.dlq).length;
          let calls = 0;
          const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
            if (++calls === step) throw new Error(`injected fsync failure ${step}`);
            return sync(fd);
          });
          try { await deliverDirect(msg); } finally { fault.mockRestore(); }
          expect(calls).toBeGreaterThanOrEqual(step);
          expect(acks.length).toBe(beforeAcks);
          expect(fs.existsSync(relayAcceptanceReceiptPath("remote", body.id))).toBe(false);
          expect(jsonFiles(inbox.fresh).length + jsonFiles(inbox.dlq).length).toBe(beforeRecords);
          expect(drainOutbox(false).map((m) => m.id)).toContain(body.id);
          await deliverDirect(msg);
          expect(acks.length).toBe(beforeAcks + 1);
          expect(jsonFiles(inbox.fresh).length + jsonFiles(inbox.dlq).length).toBe(beforeRecords + 1);
          expect(drainOutbox(false)).toEqual([]);
        }
      });
    }

    test("DLQ record is removed after receipt failure and written on redelivery", async () => {
      fillInbox();
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "DLQ retry", SEEDS)));
      const inbox = getInbox("local");
      const marker = relayAcceptanceReceiptPath("remote", body.id);
      fs.mkdirSync(`${marker}.tmp`, { recursive: true });
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body };
      await deliverDirect(msg);
      expect(acks).toEqual([]);
      expect(jsonFiles(inbox.dlq)).toEqual([]);
      fs.rmSync(`${marker}.tmp`, { recursive: true });
      await deliverDirect(msg);
      expect(acks.length).toBe(1);
      expect(jsonFiles(inbox.dlq).length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });

    test("an invalid recipient is dead-lettered to the host-level dlq and acknowledged", async () => {
      queueOutboxMessage("bad.recipient", "nowhere", "remote");
      spyOn(console, "error").mockImplementation(() => {});
      await start();
      await emit();
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
      const dlq = join(process.env.TPS_MAIL_DIR!, ".undeliverable", "dlq");
      const [file] = jsonFiles(dlq);
      expect(JSON.parse(fs.readFileSync(join(dlq, file!), "utf8")).to).toBe("bad.recipient");
      expect(fs.readFileSync(join(dlq, `${file}.reason`), "utf8")).toContain("class: invalid");
      expect(fs.existsSync(join(process.env.TPS_MAIL_DIR!, "bad.recipient"))).toBe(false);
    });

    test("with room the entry point writes the inbox and acknowledges the source", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "hello", SEEDS)));
      await start();
      await emit();
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(jsonFiles(getInbox("local").dlq)).toEqual([]);
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });

    for (const shape of ["uuid", "64-hex"] as const) {
      test(`a ${shape} delivery id produces one inbox record, one ACK and an empty outbox`, async () => {
        const env = buildSignedEnvelope("remote", "local", `${shape} delivery`, SEEDS);
        const id = shape === "64-hex" ? "ab".repeat(32) : queue(JSON.stringify(env)).id;
        if (shape === "64-hex") queueOutboxMessage("local", JSON.stringify(env), "remote", id);
        const item = drainOutbox(false).find((record) => record.id === id)!;
        const body = { id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp };
        await start();
        await emit();
        expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
        expect(acks.map((ack) => (ack.body as { id: string }).id)).toEqual([id]);
        expect(drainOutbox(false)).toEqual([]);
        const replay: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 2, ts: new Date().toISOString(), body };
        for (const handler of handlers) handler(replay);
        await Bun.sleep(0);
        expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
        expect(acks.length).toBe(2);
      });

      test(`the same ${shape} delivery id from two branches is delivered for each`, async () => {
        const kp = generateKeyPair();
        registerBranch("remote-b", kp.signing.publicKey, undefined, kp.encryption.publicKey);
        const dirB = join(root, ".tps", "branch-office", "remote-b");
        fs.mkdirSync(dirB, { recursive: true });
        fs.writeFileSync(join(dirB, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
        await start();
        const before = handlers.size;
        if (entry === "sync") {
          completion = Promise.all([completion, syncRemoteBranch("remote-b")]);
        } else {
          const stopA = stop;
          const stopB = await connectAndKeepAlive("remote-b");
          stop = async () => { await stopB(); await stopA?.(); };
        }
        for (let i = 0; handlers.size === before && i < 100; i++) await Bun.sleep(10);
        expect(handlers.size).toBeGreaterThan(before);
        const id = shape === "64-hex" ? "cd".repeat(32) : randomUUID();
        const content = JSON.stringify(buildSignedEnvelope("remote", "local", "same id", SEEDS));
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: { id, from: "remote", to: "local", content, timestamp: new Date().toISOString() } };
        for (const handler of handlers) handler(msg);
        await Bun.sleep(0);
        expect(jsonFiles(getInbox("local").fresh).length).toBe(2);
        expect(acks.length).toBe(2);
      });
    }

    test("a malformed delivery id is refused and logged without the payload", async () => {
      const errors = spyOn(console, "error").mockImplementation(() => {});
      await start();
      const malformed = ["not-a-delivery-id", "AB".repeat(32), "ab".repeat(32) + "a"];
      for (const id of malformed) {
        const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: { id, from: "remote", to: "local", content: "payload-text", timestamp: new Date().toISOString() } };
        for (const handler of handlers) handler(msg);
      }
      await Bun.sleep(0);
      expect(acks).toEqual([]);
      expect(jsonFiles(getInbox("local").fresh)).toEqual([]);
      const refusals = errors.mock.calls.flat().map(String).filter((line) => line.includes("[relay] refused a MAIL_DELIVER from branch remote: invalid id"));
      expect(refusals.length).toBe(malformed.length);
      const logs = errors.mock.calls.flat().map(String).join("\n");
      expect(logs).not.toContain("payload-text");
      for (const id of malformed) expect(logs).not.toContain(id);
    });

    test("a UUID with a matching record and an unscoped marker reuses the record", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "accepted before upgrade", SEEDS)));
      sendMessage(body.to, body.content, body.from, { branchId: "remote", id: body.id }, body.timestamp);
      const legacy = join(process.env.TPS_MAIL_DIR!, ".relay-accepted");
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(join(legacy, body.id), "");
      await start();
      await emit();
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });
  });
}
