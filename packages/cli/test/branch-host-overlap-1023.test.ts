import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { fingerprint, generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { getInbox } from "../src/utils/mail.js";
import * as ws from "../src/utils/ws-noise-transport.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import { MSG_HEARTBEAT } from "../src/utils/wire-mail.js";

afterEach(() => { mock.restore(); });

// The real fs.watch, taken before any test spies on it.
const realWatch = fs.watch;

async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`${what}: timeout`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Two authenticated sockets against the real branch listener. */
describe("branch listener with two host connections", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let branch: TpsKeyPair;
  let server: TransportServer | undefined;
  let watchers: fs.FSWatcher[];
  let channels: TransportChannel[];
  let receiverChannels: TransportChannel[];
  let signals: Map<"SIGTERM" | "SIGINT", Set<NodeJS.SignalsListener>>;
  let serverError: unknown;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-branch-overlap-"));
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_MAIL_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_AGENT_ID"]) savedEnv[key] = process.env[key];
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_VAULT_KEY = "branch-overlap-test";
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    process.env.TPS_AGENT_ID = "local";
    branch = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR, "branch");
    getInbox("local");
    watchers = [];
    channels = [];
    receiverChannels = [];
    serverError = undefined;
    signals = new Map((["SIGTERM", "SIGINT"] as const).map((signal) => [signal, new Set(process.listeners(signal))]));
    spyOn(fs, "watch").mockImplementation(((filename: fs.PathLike, listener: fs.WatchListener<string>) => {
      const watcher = realWatch(filename, listener);
      watchers.push(watcher);
      return watcher;
    }) as typeof fs.watch);
  });

  async function stop(): Promise<void> {
    const running = server;
    server = undefined;
    for (const channel of channels.splice(0)) await channel.close();
    for (const channel of receiverChannels.splice(0)) try { await channel.close(); } catch {}
    for (const watcher of watchers.splice(0)) watcher.close();
    await running?.close();
    for (const [signal, before] of signals) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
    fs.rmSync(join(root, "branch.pid"), { force: true });
  }

  afterEach(async () => {
    try {
      await stop();
    } finally {
      mock.restore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("two authenticated sockets are accepted together, and a message makes the sender active", async () => {
    const host = generateKeyPair();
    // Observe the real listener so the bound port is known and the accepted
    // channels can be closed; the listener, handshake and channels are real.
    const listener = ws.listenForHostWs;
    spyOn(ws, "listenForHostWs").mockImplementation((async (...args: Parameters<typeof ws.listenForHostWs>) => {
      expect(args[2]).toBe(0);
      const actual = await listener(...args);
      const onConnection = actual.onConnection.bind(actual);
      spyOn(actual, "onConnection").mockImplementation((handler) => {
        onConnection((channel) => {
          receiverChannels.push(channel);
          handler(channel);
        });
      });
      server = actual;
      return actual;
    }) as typeof ws.listenForHostWs);

    fs.writeFileSync(join(root, "identity", "host.json"), JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }));
    writeBranchConf(0, "127.0.0.1", "ws", undefined, "local");
    void runBranch({ action: "start" }).catch((error: unknown) => { serverError = error; });
    await waitUntil(() => server !== undefined || serverError !== undefined, "listener");
    if (serverError) throw serverError;
    const port = server?.port?.();
    if (!port) throw new Error("listener did not report its bound port");

    const open = async (): Promise<TransportChannel> => {
      const channel = await new ws.WsNoiseTransport(host).connect({ host: "127.0.0.1", port, branchId: "local", hostPublicKey: branch.encryption.publicKey });
      channels.push(channel);
      expect(channel.peerFingerprint()).toBe(fingerprint(branch.encryption.publicKey));
      return channel;
    };
    const exchange = (channel: TransportChannel, seq: number): Promise<TpsMessage> => new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); channel.offMessage(handler); };
      const handler = (received: TpsMessage) => {
        if (received.type !== MSG_HEARTBEAT || received.seq !== seq) return;
        cleanup();
        resolve(received);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("heartbeat echo timeout")); }, 5000);
      channel.onMessage(handler);
      channel.send({ type: MSG_HEARTBEAT, seq, ts: new Date().toISOString(), body: {} }).catch((error: unknown) => { cleanup(); reject(error); });
    });

    const first = await open();
    await waitUntil(() => receiverChannels.length === 1, "first connection");
    const second = await open();
    await waitUntil(() => receiverChannels.length === 2, "second connection");
    // Both sockets are open at once: accepting the second closed neither.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.isAlive()).toBe(true);
    expect(second.isAlive()).toBe(true);

    // A message on the channel that is not active closes the active channel and
    // makes the sender active (the onMessage handler in packages/cli/src/commands/branch.ts);
    // the branch echoes the heartbeat on the sender.
    await exchange(first, 1);
    await waitUntil(() => !second.isAlive(), "active channel closed");
    expect(first.isAlive()).toBe(true);
    await exchange(first, 2);
    expect(first.isAlive()).toBe(true);
  }, 30_000);
});
