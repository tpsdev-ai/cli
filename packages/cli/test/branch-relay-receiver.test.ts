import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MailClient } from "@tpsdev-ai/agent";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { gcMessages, getInbox } from "../src/utils/mail.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import { generateKeyPair, initHostIdentity, registerBranch, saveKeyPair } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { writeKeyFile, buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

const SEEDS = { remote: Buffer.alloc(32, 0x11), local: Buffer.alloc(32, 0x22) };
// The peer host's fingerprint, as the branch channel reports it.
const HOST_FP = "a".repeat(64);

/**
 * The branch-side relay receiver (packages/cli/src/commands/branch.ts). These
 * drive the real receiver — captured from the mocked `listenForHostWs` — against
 * real mailbox files, and read back what it published and whether it ACKed.
 */
describe("branch relay receiver records the delivery before the ACK", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let branchReceive: (msg: TpsMessage, channel: TransportChannel) => void | Promise<void>;
  let sent: TpsMessage[];
  let channel: TransportChannel;
  let signalListeners: Map<"SIGTERM" | "SIGINT", Set<(...args: any[]) => void>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-branch-recv-"));
    savedEnv = {};
    for (const k of [
      "HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "FLAIR_SIGNING_KEY_PATH",
      "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_ROOT",
    ]) savedEnv[k] = process.env[k];
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "branch-recv-test";
    process.env.FLAIR_URL = "http://flair.invalid";
    process.env.FLAIR_KEY_PATH = writeKeyFile(join(root, "keys"), "local", SEEDS.local);
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const name = new URL(String(input)).pathname.match(/^\/Agent\/(.+)$/)?.[1];
      const seed = name && SEEDS[name as keyof typeof SEEDS];
      return seed
        ? Response.json({ id: name, name, publicKey: pubkeyFromSeed(seed).toString("base64") })
        : new Response("not found", { status: 404 });
    });
    await initHostIdentity();
    const kp = generateKeyPair();
    registerBranch("remote", kp.signing.publicKey, undefined, kp.encryption.publicKey);
    const branchDir = join(root, ".tps", "branch-office", "remote");
    fs.mkdirSync(branchDir, { recursive: true });
    fs.writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
    saveKeyPair(kp, process.env.TPS_IDENTITY_DIR!, "branch");
    fs.writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(kp.encryption.publicKey).toString("base64url") }),
    );
    writeBranchConf(1, "unused", "ws", undefined, "remote");

    sent = [];
    channel = {
      async send(msg) { sent.push(msg); },
      onMessage() {},
      offMessage() {},
      async close() {},
      isAlive() { return true; },
      peerFingerprint() { return HOST_FP; },
    };
    spyOn(ws, "listenForHostWs").mockImplementation(async (_kp, _host, _port, handler) => {
      branchReceive = handler;
      return { onConnection() {}, async close() {} };
    });
    spyOn(fs, "watch").mockReturnValue({ close() {} } as fs.FSWatcher);
    signalListeners = new Map(
      (["SIGTERM", "SIGINT"] as const).map((signal) => [signal, new Set(process.listeners(signal))]),
    );
    void runBranch({ action: "start" });
    expect(branchReceive!).toBeDefined();
    // The recipient's inbox must exist so the receiver routes to `local` (it
    // falls back to the branch's own agent when `local` has no inbox here).
    getInbox("local");
  });

  afterEach(() => {
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

  function dirFiles(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  function counts(): { fresh: number; cur: number; dlq: number } {
    const inbox = getInbox("local");
    return {
      fresh: dirFiles(inbox.fresh).length,
      cur: dirFiles(inbox.cur).length,
      dlq: dirFiles(inbox.dlq).length,
    };
  }

  function acks(): TpsMessage[] {
    return sent.filter((m) => m.type === MSG_MAIL_ACK);
  }

  function delivery(over: Partial<MailDeliverBody> = {}): MailDeliverBody {
    const id = over.id ?? randomUUID();
    return {
      id,
      from: over.from ?? "remote",
      to: over.to ?? "local",
      content: over.content ?? `relay ${id}`,
      timestamp: over.timestamp ?? new Date().toISOString(),
      ...over,
    };
  }

  async function deliver(body: MailDeliverBody): Promise<void> {
    await branchReceive({ type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body }, channel);
    await Bun.sleep(0);
  }

  function readOnlyFile(dir: string, names: string[]): string {
    return fs.readFileSync(join(dir, names[0]!), "utf-8");
  }

  test("a delivery whose ACK fails is published once and reused on resend", async () => {
    const body = delivery();
    const send = channel.send;
    channel.send = async (msg) => {
      if (msg.type === MSG_MAIL_ACK) throw new Error("injected ACK failure");
      return send(msg);
    };
    await deliver(body);
    channel.send = send;
    expect(acks()).toEqual([]);
    // Durable before the ACK: the record is on disk even though no ACK left.
    expect(counts().fresh).toBe(1);
    const published = JSON.parse(readOnlyFile(getInbox("local").fresh, dirFiles(getInbox("local").fresh)));
    expect(published.relayDelivery).toEqual({ branchId: HOST_FP, id: body.id });

    await deliver(body);
    expect(acks().map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);
    expect(counts().fresh).toBe(1);
  });

  test("a resend after GC removed the unread record republishes it, then reuses it", async () => {
    const body = delivery();
    await deliver(body);
    expect(acks().map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);

    const fresh = getInbox("local").fresh;
    const [file] = dirFiles(fresh);
    const record = JSON.parse(fs.readFileSync(join(fresh, file!), "utf-8"));
    record.receivedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(join(fresh, file!), JSON.stringify(record));
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-01T00:00:00.000Z"));
    try { expect(gcMessages("local", "24h", undefined, "1s")).toBe(1); }
    finally { clock.mockRestore(); }
    expect(counts().fresh).toBe(0);

    // The host resends the same delivery; its record is gone, so it is published
    // again rather than ACKed with nothing on disk.
    await deliver(body);
    expect(counts().fresh).toBe(1);
    // The republished record is the delivery's, so a further resend reuses it.
    await deliver(body);
    expect(counts().fresh).toBe(1);
    expect(acks()).toHaveLength(3);
  });

  test("a resend reusing a consumed envelope id republishes and the replay gate holds", async () => {
    const envelope = buildSignedEnvelope("remote", "local", "original delivery", SEEDS);
    const first = delivery({ content: JSON.stringify(envelope) });
    await deliver(first);

    const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, "local", {
      async getAgent(id) {
        const seed = SEEDS[id as keyof typeof SEEDS];
        return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
      },
    });
    expect(await client.checkNewMail()).toHaveLength(1); // promoted; messageId consumed

    // A fresh delivery reuses the consumed envelope id.
    const reused = buildSignedEnvelope("remote", "local", "different delivery", SEEDS, { messageId: envelope.messageId });
    const second = delivery({ content: JSON.stringify(reused) });
    await deliver(second);
    await deliver(second); // its resend reuses the delivered record
    expect(counts().fresh).toBe(1);
    expect(counts().cur).toBe(1);
    expect(acks().map((ack) => (ack.body as { id: string }).id)).toEqual([first.id, second.id, second.id]);

    // Exactly-once to the agent: the replay gate refuses the reused id.
    expect(await client.checkNewMail()).toEqual([]);
    const dlq = getInbox("local").dlq;
    const [rejected] = dirFiles(dlq);
    expect(fs.readFileSync(join(dlq, `${rejected!}.reason`), "utf-8")).toContain("class: replay");
  });

  test("a resend of the same delivery id with a different payload is refused without an ACK", async () => {
    const body = delivery({ content: "original payload" });
    await deliver(body);
    expect(acks().map((ack) => ack.body)).toEqual([{ id: body.id, accepted: true }]);

    const fresh = getInbox("local").fresh;
    const [file] = dirFiles(fresh);
    const source = join(fresh, file!);
    const before = fs.readFileSync(source, "utf-8");

    await deliver({ ...body, content: "different payload" });
    expect(acks()).toHaveLength(1); // the conflicting resend is not ACKed
    expect(fs.readFileSync(source, "utf-8")).toBe(before);
    expect(counts().fresh).toBe(1);
  });
});
