import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getInbox, MAX_INBOX_MESSAGES, sendMessage } from "../src/utils/mail.js";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { runMail } from "../src/commands/mail.js";
import { syncRemoteBranch, connectAndKeepAlive } from "../src/utils/relay.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import { generateKeyPair, initHostIdentity, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import { drainOutbox, queueOutboxMessage } from "../src/utils/outbox.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, MSG_HEARTBEAT, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { writeKeyFile, buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

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

    for (const fault of ["sidecar", "record", "crash-before-publish"] as const) {
      test(`${fault} failure leaves the branch source unacked and retryable`, async () => {
        fillInbox();
        const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "retry me", SEEDS)));
        const inbox = getInbox("local");
        const errors = spyOn(console, "error").mockImplementation(() => {});
        await start();
        const write = fs.writeFileSync;
        const rename = fs.renameSync;
        const injected = fault === "crash-before-publish"
          ? spyOn(fs, "renameSync").mockImplementation((src, dst) => {
            if (String(dst).startsWith(inbox.dlq)) throw new Error("simulated crash before publish");
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
        if (fault === "crash-before-publish") expect(fs.readdirSync(inbox.dlq).some((f) => f.endsWith(".reason"))).toBe(true);
        const logs = errors.mock.calls.flat().join("\n");
        expect(logs).toContain(body.id);
        expect(logs).toContain("local");
        expect(logs).toContain(fault === "crash-before-publish" ? "simulated crash" : `injected ${fault}`);
        await emit();
        expect(acks.length).toBe(1);
        expect(drainOutbox(false)).toEqual([]);
        expect(jsonFiles(inbox.dlq).length).toBe(1);
      });
    }

    test("with room the entry point writes the inbox and acknowledges the source", async () => {
      const body = queue(JSON.stringify(buildSignedEnvelope("remote", "local", "hello", SEEDS)));
      await start();
      await emit();
      expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
      expect(jsonFiles(getInbox("local").dlq)).toEqual([]);
      expect(acks.length).toBe(1);
      expect(drainOutbox(false)).toEqual([]);
    });
  });
}
