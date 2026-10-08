import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { fingerprint, generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { getInbox } from "../src/utils/mail.js";
import * as tcp from "../src/utils/noise-ik-transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import { MailDeliverBodySchema, MSG_HEARTBEAT, MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("receiver timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function exchange(channel: TransportChannel, message: TpsMessage, replyType: number): Promise<TpsMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); channel.offMessage(handler); };
    const handler = (received: TpsMessage) => {
      if (received.type !== replyType || received.seq !== message.seq) return;
      cleanup();
      resolve(received);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("reply timeout")); }, 5000);
    channel.onMessage(handler);
    channel.send(message).catch((error: unknown) => { cleanup(); reject(error); });
  });
}

describe("branch relay authenticated channels", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let branch: TpsKeyPair;
  let server: TransportServer | undefined;
  let watchers: fs.FSWatcher[];
  let channels: TransportChannel[];
  let receiverChannels: TransportChannel[];
  let signals: Map<"SIGTERM" | "SIGINT", Set<NodeJS.SignalsListener>>;
  let acknowledgements: Array<{ peer: string; files: string[]; records: unknown[] }>;

  function files(): string[] {
    return fs.readdirSync(getInbox("local").fresh).filter((file) => file.endsWith(".json")).sort();
  }
  function record(file: string) {
    return JSON.parse(fs.readFileSync(join(getInbox("local").fresh, file), "utf8"));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-branch-channel-"));
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_MAIL_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_AGENT_ID"]) savedEnv[key] = process.env[key];
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_VAULT_KEY = "branch-channel-test";
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    process.env.TPS_AGENT_ID = "local";
    branch = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR, "branch");
    getInbox("local");
    watchers = [];
    channels = [];
    receiverChannels = [];
    acknowledgements = [];
    signals = new Map((["SIGTERM", "SIGINT"] as const).map((signal) => [signal, new Set(process.listeners(signal))]));
    const watch = fs.watch;
    spyOn(fs, "watch").mockImplementation(((filename: fs.PathLike, listener: fs.WatchListener<string>) => {
      const watcher = watch(filename, listener);
      watchers.push(watcher);
      return watcher;
    }) as typeof fs.watch);
  });

  async function stop(): Promise<void> {
    for (const channel of channels.splice(0)) await channel.close();
    for (const channel of receiverChannels.splice(0)) await channel.close();
    for (const watcher of watchers.splice(0)) watcher.close();
    await server?.close();
    server = undefined;
    for (const [signal, before] of signals) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
    fs.rmSync(join(root, "branch.pid"), { force: true });
  }

  afterEach(async () => {
    await stop();
    mock.restore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const transport of ["ws", "tcp"] as const) {
    test(`${transport} inbox delivery keys and reconnects`, async () => {
      const host = generateKeyPair();
      const otherHost = generateKeyPair();
      const hostFingerprint = fingerprint(host.encryption.publicKey);
      const otherFingerprint = fingerprint(otherHost.encryption.publicKey);
      expect(otherFingerprint).not.toBe(hostFingerprint);
      const observe = async (listener: typeof ws.listenForHostWs, ...args: Parameters<typeof ws.listenForHostWs>) => {
        const actual = await listener(...args);
        const onConnection = actual.onConnection.bind(actual);
        spyOn(actual, "onConnection").mockImplementation((handler) => {
          onConnection((channel) => {
            receiverChannels.push(channel);
            const send = channel.send.bind(channel);
            spyOn(channel, "send").mockImplementation(async (message) => {
              if (message.type === MSG_MAIL_ACK) {
                const persisted = files();
                acknowledgements.push({ peer: channel.peerFingerprint(), files: persisted, records: persisted.map(record) });
              }
              await send(message);
            });
            handler(channel);
          });
        });
        server = actual;
        return actual;
      };
      if (transport === "ws") {
        const listener = ws.listenForHostWs;
        spyOn(ws, "listenForHostWs").mockImplementation((...args) => observe(listener, ...args));
      } else {
        const listener = tcp.listenForHost;
        spyOn(tcp, "listenForHost").mockImplementation((...args) => observe(listener, ...args));
      }
      let startupError: unknown;
      async function start(peer: TpsKeyPair): Promise<number> {
        const port = await freePort();
        fs.writeFileSync(join(root, "identity", "host.json"), JSON.stringify({ publicKey: Buffer.from(peer.encryption.publicKey).toString("base64url") }));
        writeBranchConf(port, "127.0.0.1", transport, undefined, "local");
        void runBranch({ action: "start" }).catch((error: unknown) => { startupError = error; });
        await waitUntil(() => server !== undefined || startupError !== undefined);
        if (startupError) throw startupError;
        return port;
      }
      async function connect(peer: TpsKeyPair, port: number): Promise<TransportChannel> {
        const client = transport === "ws" ? new ws.WsNoiseTransport(peer) : new tcp.NoiseIkTransport(peer);
        const channel = await client.connect({ host: "127.0.0.1", port, branchId: "local", hostPublicKey: branch.encryption.publicKey });
        channels.push(channel);
        expect(channel.peerFingerprint()).toBe(fingerprint(branch.encryption.publicKey));
        return channel;
      }
      const body = MailDeliverBodySchema.parse({ id: randomUUID(), from: "remote", to: "local", content: "original", timestamp: "2026-10-07T00:00:00.000Z" });
      const message = (seq: number, content = body.content): TpsMessage => ({ type: MSG_MAIL_DELIVER, seq, ts: body.timestamp, body: { ...body, content } });
      const port = await start(host);
      const first = await connect(host, port);
      expect((await exchange(first, message(1), MSG_MAIL_ACK)).body).toEqual({ id: body.id, accepted: true });
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]).toMatchObject({ peer: hostFingerprint, records: [{ relayDelivery: { branchId: hostFingerprint, id: body.id }, body: "original" }] });
      const [originalFile] = files();
      expect(files()).toHaveLength(1);
      if (!originalFile) throw new Error("missing delivery record");
      const originalId = record(originalFile).id;
      const originalReceiver = receiverChannels[0];
      expect(originalReceiver?.peerFingerprint()).toBe(hostFingerprint);
      await first.close();
      const resend = await connect(host, port);
      expect(resend).not.toBe(first);
      expect((await exchange(resend, message(2), MSG_MAIL_ACK)).body).toEqual({ id: body.id, accepted: true });
      expect(receiverChannels[1]).not.toBe(originalReceiver);
      expect(files()).toEqual([originalFile]);
      expect(record(originalFile).id).toBe(originalId);
      expect(acknowledgements[1]).toMatchObject({ peer: hostFingerprint, files: [originalFile], records: [{ relayDelivery: { branchId: hostFingerprint, id: body.id } }] });
      const received: TpsMessage[] = [];
      resend.onMessage((incoming) => received.push(incoming));
      const beforeConflict = fs.readFileSync(join(getInbox("local").fresh, originalFile), "utf8");
      await resend.send(message(3, "conflict"));
      await waitUntil(() => fs.readFileSync(join(root, "branch.log"), "utf8").includes("relayed delivery conflict"));
      await exchange(resend, { type: MSG_HEARTBEAT, seq: 4, ts: body.timestamp, body: {} }, MSG_HEARTBEAT);
      expect(received.filter((incoming) => incoming.type === MSG_MAIL_ACK && incoming.seq === 3)).toEqual([]);
      expect(acknowledgements).toHaveLength(2);
      expect(fs.readFileSync(join(getInbox("local").fresh, originalFile), "utf8")).toBe(beforeConflict);
      await stop();
      const otherPort = await start(otherHost);
      const differentPeer = await connect(otherHost, otherPort);
      expect((await exchange(differentPeer, message(5), MSG_MAIL_ACK)).body).toEqual({ id: body.id, accepted: true });
      expect(files()).toHaveLength(2);
      const otherFile = files().find((file) => file !== originalFile);
      if (!otherFile) throw new Error("missing other peer record");
      expect(record(otherFile)).toMatchObject({ relayDelivery: { branchId: otherFingerprint, id: body.id }, body: "original" });
      expect(record(otherFile).id).not.toBe(originalId);
      expect(acknowledgements[2]).toMatchObject({ peer: otherFingerprint, records: expect.arrayContaining([expect.objectContaining({ relayDelivery: { branchId: otherFingerprint, id: body.id } })]) });
      expect(fs.readFileSync(join(getInbox("local").fresh, originalFile), "utf8")).toBe(beforeConflict);
    }, 30000);
  }
});
