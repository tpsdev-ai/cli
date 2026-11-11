import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateLockRoot, hostStatePath } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, loadHostIdentity, registerBranch } from "../src/utils/identity.js";
import { mailLockPath } from "../src/utils/mail-lock.js";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import { MSG_HEARTBEAT } from "../src/utils/wire-mail.js";
import { listenForHostWs, WsNoiseTransport } from "../src/utils/ws-noise-transport.js";

afterEach(() => { mock.restore(); });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no address"));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for relay message");
    await Bun.sleep(10);
  }
}

test("a real WS late connect closes its socket and stop() clears the host record", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-late-connect-ws-896-"));
  const saved = { HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
    TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
    TPS_VAULT_KEY: process.env.TPS_VAULT_KEY };
  const realSetTimeout = globalThis.setTimeout;
  // Shorten only the 4 s reconnect wait; the stop() deadline keeps its real length.
  const reconnectBackoff = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 4_000) return realSetTimeout(callback, 50, ...args);
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const originalConnect = WsNoiseTransport.prototype.connect;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let connectCalls = 0;
  const connect = spyOn(WsNoiseTransport.prototype, "connect").mockImplementation(function (
    this: WsNoiseTransport,
    ...args: Parameters<typeof originalConnect>
  ) {
    const call = ++connectCalls;
    if (call === 1) return originalConnect.apply(this, args);
    return (async () => { await gate; return originalConnect.apply(this, args); })();
  });
  let server: TransportServer | undefined;
  let stop: (() => Promise<void>) | undefined;
  const peers: TransportChannel[] = [];
  const STOP_BOUND_MS = 8_000;
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "relay-late-connect-ws-test";
    await initHostIdentity();
    const host = await loadHostIdentity();
    const branch = generateKeyPair();
    registerBranch("remote", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const port = await freePort();
    server = await listenForHostWs(branch, host.encryption.publicKey, port, () => {});
    server.onConnection((channel) => { peers.push(channel); });
    const dir = join(root, ".tps", "branch-office", "remote");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }));
    stop = await connectAndKeepAlive("remote");
    const path = hostStatePath("remote");
    // The first connection writes the record; dropping its socket makes the loop
    // reconnect, and that second connect waits on the gate.
    await waitFor(() => peers.length === 1 && existsSync(path));
    await peers[0].close();
    await waitFor(() => connectCalls === 2);
    let stopSettled = false;
    const stopping = stop().then(
      () => { stopSettled = true; return null; },
      (error: unknown) => { stopSettled = true; return error; },
    );
    await Bun.sleep(20);
    expect(stopSettled, "stop() must wait for the in-flight connect").toBe(false);
    releaseGate();
    const bound = new Promise<"bound">((resolve) => {
      boundTimer = realSetTimeout(() => resolve("bound"), STOP_BOUND_MS);
    });
    const outcome = await Promise.race([stopping, bound]);
    expect(outcome, `stop() must settle within ${STOP_BOUND_MS} ms`).not.toBe("bound");
    expect(outcome).toBeNull();
    await waitFor(() => peers.length === 2 && !peers[1].isAlive());
    expect(existsSync(path)).toBe(false);
  } finally {
    if (boundTimer !== undefined) clearTimeout(boundTimer);
    releaseGate();
    await stop?.().catch(() => {});
    connect.mockRestore();
    reconnectBackoff.mockRestore();
    diagnostic.mockRestore();
    await server?.close();
    await Bun.sleep(1100);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a real WS channel delivers inbound messages while host persistence retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-inbound-socket-748-"));
  const saved = { HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
    TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
    TPS_VAULT_KEY: process.env.TPS_VAULT_KEY };
  let server: TransportServer | undefined;
  let peer: TransportChannel | undefined;
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "relay-host-record-test";
    await initHostIdentity();
    const host = await loadHostIdentity();
    const branch = generateKeyPair();
    registerBranch("remote", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const port = await freePort();
    let heartbeat = false;
    server = await listenForHostWs(branch, host.encryption.publicKey, port, () => { heartbeat = true; });
    server.onConnection((channel) => { peer = channel; });
    const dir = join(root, ".tps", "branch-office", "remote");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }));
    const received: TpsMessage[] = [];
    stop = await connectAndKeepAlive("remote", { onMessage: (message) => { received.push(message); } });
    const path = hostStatePath("remote");
    await waitFor(() => peer !== undefined && heartbeat && existsSync(path));
    await Bun.sleep(20);
    lockRoot = hostStateLockRoot(path);
    const lockDir = mailLockPath(lockRoot);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startToken: null }));
    diagnostic.mockClear();
    const message = { type: MSG_HEARTBEAT, seq: 9, ts: new Date().toISOString(), body: {} };
    await peer!.send(message);
    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual(message);
    expect(peer!.isAlive()).toBe(true);
    await waitFor(() => diagnostic.mock.calls.length > 0);
    expect(diagnostic.mock.calls[0][0]).toContain(`Host state record ${path} update failed; message handling continues`);
    rmSync(lockRoot, { recursive: true, force: true });
    lockRoot = undefined;
    await peer!.send({ ...message, seq: 10 });
    await waitFor(() => received.length === 2);
    expect(peer!.isAlive()).toBe(true);
  } finally {
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    await stop?.();
    await server?.close();
    await Bun.sleep(1100);
    diagnostic.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
