import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { processStartToken } from "@tpsdev-ai/agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOffice } from "../src/commands/office.js";
import { hostStateLockRoot, hostStatePath } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { mailLockPath } from "../src/utils/mail-lock.js";
import { readPidFile } from "../src/utils/pid-file.js";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import type { TransportChannel } from "../src/utils/transport.js";
import { MSG_HEARTBEAT } from "../src/utils/wire-mail.js";
import * as ws from "../src/utils/ws-noise-transport.js";

afterEach(() => { mock.restore(); });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Register a branch and its remote.json under an isolated root. */
async function prepareBranch(root: string): Promise<string> {
  process.env.HOME = root;
  process.env.TPS_ROOT = root;
  process.env.TPS_IDENTITY_DIR = join(root, "identity");
  process.env.TPS_REGISTRY_DIR = join(root, "registry");
  process.env.TPS_VAULT_KEY = "relay-host-record-test";
  await initHostIdentity();
  const branch = "remote";
  const keys = generateKeyPair();
  registerBranch(branch, keys.signing.publicKey, undefined, keys.encryption.publicKey);
  const branchDir = join(root, ".tps", "branch-office", branch);
  mkdirSync(branchDir, { recursive: true });
  writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
  return branch;
}

const savedRelayEnv = () => ({ HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
  TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
  TPS_VAULT_KEY: process.env.TPS_VAULT_KEY });

function restoreRelayEnv(saved: ReturnType<typeof savedRelayEnv>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("connectAndKeepAlive writes a host record that readPidFile verifies as running", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-host-record-719-"));
  const savedEnv = { HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
    TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
    TPS_VAULT_KEY: process.env.TPS_VAULT_KEY };
  let stop: (() => Promise<void>) | undefined;
  let attached = false;
  let detached = false;
  let alive = true;
  const channel: TransportChannel = {
    async send() {},
    onMessage() { attached = true; },
    offMessage() { detached = true; },
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  try {
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "relay-host-record-test";
    await initHostIdentity();
    const branch = "remote";
    const keys = generateKeyPair();
    registerBranch(branch, keys.signing.publicKey, undefined, keys.encryption.publicKey);
    const branchDir = join(root, ".tps", "branch-office", branch);
    mkdirSync(branchDir, { recursive: true });
    writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));

    stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    for (let i = 0; (!existsSync(path) || !attached) && i < 200; i++) await Bun.sleep(5);
    const record = JSON.parse(readFileSync(path, "utf8"));
    const token = processStartToken(process.pid);
    expect(record.pid).toBe(process.pid);
    expect(record.startToken).toBe(token);
    expect(token).not.toBeNull();
    expect(readPidFile(path)).toEqual({ kind: "running", path, pid: process.pid, startToken: token });
  } finally {
    try {
      await stop?.();
      for (let i = 0; attached && !detached && i < 200; i++) await Bun.sleep(10);
      expect(attached && !detached).toBe(false);
    } finally {
      connect.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("stop() reports an invalid host record and keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-invalid-record-748-"));
  const savedEnv = savedRelayEnv();
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockReturnValue(
    new Promise<TransportChannel>(() => {}),
  );
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    mkdirSync(join(root, ".tps", "connections"), { recursive: true });
    writeFileSync(path, "{ not json");

    await expect(stop()).rejects.toThrow(path);

    expect(readFileSync(path, "utf8")).toBe("{ not json");
  } finally {
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

// A directory in the record's place is not a regular file, so the read is
// refused for every uid, root included.
test("stop() reports a host record that is not a regular file and keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-unreadable-record-748-"));
  const savedEnv = savedRelayEnv();
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockReturnValue(
    new Promise<TransportChannel>(() => {}),
  );
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    mkdirSync(path, { recursive: true });

    await expect(stop()).rejects.toThrow(path);

    expect(readdirSync(path)).toEqual([]);
  } finally {
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop() suppresses the host record write of a connection that resolves after stop()", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-stop-connect-748-"));
  const savedEnv = savedRelayEnv();
  const connection = deferred<TransportChannel>();
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockReturnValue(connection.promise);
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);

    await stop();
    expect(existsSync(path)).toBe(false);

    let closed = false;
    connection.resolve({
      async send() {},
      onMessage() {},
      offMessage() {},
      async close() { closed = true; },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    });
    for (let i = 0; !closed && i < 200; i++) await Bun.sleep(5);
    expect(closed).toBe(true);
    expect(existsSync(path)).toBe(false);
  } finally {
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop() suppresses the host record write of a heartbeat send that resolves after stop()", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-stop-send-748-"));
  const savedEnv = savedRelayEnv();
  const sent = deferred<void>();
  let alive = true;
  let detached = false;
  const channel: TransportChannel = {
    send() { return sent.promise; },
    onMessage() {},
    offMessage() { detached = true; },
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    for (let i = 0; !existsSync(path) && i < 200; i++) await Bun.sleep(5);
    expect(existsSync(path)).toBe(true);

    await stop();
    expect(existsSync(path)).toBe(false);

    sent.resolve(undefined);
    for (let i = 0; !detached && i < 200; i++) await Bun.sleep(5);
    expect(detached).toBe(true);
    expect(existsSync(path)).toBe(false);
  } finally {
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

function holdHostLock(path: string): string {
  const root = hostStateLockRoot(path);
  const dir = mailLockPath(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, startToken: null }));
  return root;
}

test.each([["close resolves", false], ["close rejects", true]] as const)("a host lock timeout attempts channel close before retry (%s)", async (_title, closeFails) => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-retry-lock-748-"));
  const savedEnv = savedRelayEnv();
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  let closes = 0;
  let attempts = 0;
  const retry = deferred<TransportChannel>();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() {
      closes++;
      if (closeFails && closes === 1) throw new Error("close refused");
    },
    isAlive() { return true; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    attempts++;
    if (attempts === 1) {
      lockRoot = holdHostLock(hostStatePath("remote"));
      return channel;
    }
    expect(closes).toBe(1);
    return retry.promise;
  });
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; attempts < 2 && i < 1400; i++) await Bun.sleep(10);
    expect(attempts).toBe(2);
    expect(closes).toBe(1);
    if (closeFails) {
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("close refused"));
    }
  } finally {
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    try {
      await stop?.();
      if (closeFails) expect(closes).toBe(2);
    } finally {
      connect.mockRestore();
      diagnostic.mockRestore();
      restoreRelayEnv(savedEnv);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test.each(["stop", "SIGINT"])("a retained channel whose close persistently rejects keeps the record and fails %s", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-stop-close-748-"));
  const savedEnv = savedRelayEnv();
  const listeners = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]);
  let stop: (() => Promise<void>) | undefined;
  let sigint: (() => Promise<void>) | undefined;
  let closes = 0;
  let rejectClose = true;
  const channel: TransportChannel = {
    async send() { throw new Error("initial heartbeat refused"); },
    onMessage() {},
    offMessage() {},
    async close() {
      closes++;
      if (rejectClose) throw new Error("close refused persistently");
    },
    isAlive() { return true; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const output = spyOn(console, "log").mockImplementation(() => {});
  const exited = new Error("test intercepted process.exit");
  const exit = spyOn(process, "exit").mockImplementation(() => { throw exited; });
  try {
    const branch = await prepareBranch(root);
    if (mode === "stop") stop = await connectAndKeepAlive(branch);
    else void runOffice({ action: "connect", agent: branch });
    const path = hostStatePath(branch);
    for (let i = 0; closes === 0 && i < 200; i++) await Bun.sleep(5);
    sigint = process.listeners("SIGINT").find((listener) => !listeners.has(listener)) as (() => Promise<void>) | undefined;
    const sigterm = process.listeners("SIGTERM").find((listener) => !listeners.has(listener));
    expect(closes).toBe(1);
    const record = readFileSync(path, "utf8");

    if (mode === "stop") {
      await expect(stop!()).rejects.toMatchObject({ name: "HostChannelCloseError", message: expect.stringContaining(path) });
    } else {
      expect(sigint).toBeDefined();
      // One checked shutdown for both signals (cli#762): a second signal while it
      // runs reaches the same single-flight guard instead of starting a second stop.
      expect(sigterm).toBe(sigint);
      await expect(sigint!()).rejects.toBe(exited);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(`Disconnect failed: Channel close rejected; host state record ${path} retained`));
    }
    expect(closes).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(record);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("close refused persistently"));
  } finally {
    rejectClose = false;
    await stop?.();
    await sigint?.().catch((error) => { if (error !== exited) throw error; });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.has(listener)) process.off(signal, listener);
      }
    }
    exit.mockRestore();
    output.mockRestore();
    diagnostic.mockRestore();
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["live", "unverifiable", "stop"])("inbound persistence under contention (%s)", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-inbound-lock-748-"));
  const savedEnv = savedRelayEnv();
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  let handler: Parameters<TransportChannel["onMessage"]>[0] | undefined;
  let alive = true;
  let detached = false;
  let closes = 0;
  const channel: TransportChannel = {
    async send() {},
    onMessage(callback) { handler = callback; },
    offMessage() { detached = true; },
    async close() { closes++; alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const onMessage = mock(() => {});
  const owner = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch, { onMessage });
    for (let i = 0; !handler && i < 200; i++) await Bun.sleep(5);
    expect(handler).toBeDefined();
    await Bun.sleep(20);
    const path = hostStatePath(branch);
    const before = JSON.parse(readFileSync(path, "utf8"));
    lockRoot = hostStateLockRoot(path);
    const lockDir = mailLockPath(lockRoot);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      pid: owner.pid, startToken: mode === "unverifiable" ? "unknown:token" : processStartToken(owner.pid),
    }));
    const message = { type: MSG_HEARTBEAT, seq: 9, ts: new Date().toISOString(), body: {} };
    diagnostic.mockClear();
    const started = performance.now();
    for (let i = 0; i < 3; i++) handler!({ ...message, seq: i });
    expect(performance.now() - started).toBeLessThan(500);
    expect(onMessage).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(onMessage).toHaveBeenNthCalledWith(i + 1, { ...message, seq: i });
    expect(diagnostic).not.toHaveBeenCalled();
    await Bun.sleep(20);
    expect(performance.now() - started).toBeLessThan(500);
    expect(alive).toBe(true);
    expect(closes).toBe(0);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0][0]).toContain(`Host state record ${path} update failed; message handling continues`);
    expect(diagnostic.mock.calls[0][0]).toContain("could not be acquired within 0 ms");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
    for (let i = 0; diagnostic.mock.calls.length < 2 && i < 100; i++) await Bun.sleep(5);
    expect(diagnostic.mock.calls.length).toBeGreaterThanOrEqual(2);
    handler!({ ...message, seq: 3 });
    expect(onMessage).toHaveBeenCalledTimes(4);
    rmSync(lockRoot, { recursive: true, force: true });
    lockRoot = undefined;
    if (mode === "stop") {
      await stop();
      await Bun.sleep(1100);
      expect(existsSync(path)).toBe(false);
    } else {
      let record = before;
      for (let i = 0; record.messagesReceived !== before.messagesReceived + 4 && i < 300; i++) {
        await Bun.sleep(5);
        record = JSON.parse(readFileSync(path, "utf8"));
      }
      expect(record.messagesReceived).toBe(before.messagesReceived + 4);
      expect(record.lastHeartbeatAck).not.toBeNull();
      expect(closes).toBe(0);
    }
  } finally {
    owner.kill();
    await owner.exited;
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    await stop?.();
    for (let i = 0; handler && !detached && i < 200; i++) await Bun.sleep(10);
    connect.mockRestore();
    diagnostic.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
