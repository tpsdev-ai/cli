import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { processStartToken } from "@tpsdev-ai/agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOffice } from "../src/commands/office.js";
import { hostStateLockRoot, hostStatePath } from "../src/utils/connection-state.js";
import { registerService } from "../src/utils/service-registry.js";
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
  const connection = deferred<TransportChannel>();
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockReturnValue(connection.promise);
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    mkdirSync(join(root, ".tps", "connections"), { recursive: true });
    writeFileSync(path, "{ not json");

    const stopping = stop();
    connection.resolve({
      async send() {}, onMessage() {}, offMessage() {}, async close() {},
      isAlive() { return true; }, peerFingerprint() { return "remote"; },
    });
    await expect(stopping).rejects.toThrow(path);

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
  const connection = deferred<TransportChannel>();
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockReturnValue(connection.promise);
  try {
    const branch = await prepareBranch(root);
    const stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    mkdirSync(path, { recursive: true });

    const stopping = stop();
    connection.resolve({
      async send() {}, onMessage() {}, offMessage() {}, async close() {},
      isAlive() { return true; }, peerFingerprint() { return "remote"; },
    });
    await expect(stopping).rejects.toThrow(path);

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

    let closed = false;
    const stopping = stop();
    await Bun.sleep(20);
    expect(existsSync(path)).toBe(false);
    expect(closed).toBe(false);
    connection.resolve({
      async send() {},
      onMessage() {},
      offMessage() {},
      async close() { closed = true; },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    });
    await stopping;
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
    const stopping = stop?.();
    retry.resolve({
      async send() {}, onMessage() {}, offMessage() {}, async close() {},
      isAlive() { return true; }, peerFingerprint() { return "remote"; },
    });
    try {
      await stopping;
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

test("an inbound refresh whose self token cannot be read keeps retrying and reports the transition once", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-self-token-779-"));
  const savedEnv = savedRelayEnv();
  const ownToken = processStartToken(process.pid);
  let token: string | null = ownToken;
  let stop: (() => Promise<void>) | undefined;
  let handler: Parameters<TransportChannel["onMessage"]>[0] | undefined;
  let alive = true;
  let detached = false;
  const channel: TransportChannel = {
    async send() {},
    onMessage(callback) { handler = callback; },
    offMessage() { detached = true; },
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch, { testHooks: { startToken: () => token } });
    for (let i = 0; !handler && i < 200; i++) await Bun.sleep(5);
    expect(handler).toBeDefined();
    await Bun.sleep(20);
    const path = hostStatePath(branch);
    const before = JSON.parse(readFileSync(path, "utf8"));
    token = null;
    diagnostic.mockClear();
    const message = { type: MSG_HEARTBEAT, seq: 0, ts: new Date().toISOString(), body: {} };
    for (let i = 0; i < 3; i++) {
      handler!({ ...message, seq: i });
      await Bun.sleep(20);
    }
    // Several refreshes (and their retries) skip the record; the diagnostic is
    // reported once for the transition into unverifiable.
    await Bun.sleep(200);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
    const skipped = diagnostic.mock.calls.filter(([line]) => String(line).includes("not refreshed"));
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0][0])).toContain(
      `[relay] host state record ${path} not refreshed: this process's start token could not be read, so ownership cannot be verified; the record keeps its last state and refreshes resume when the token reads again`,
    );
    // The token reads again: the pending retry writes without a new message,
    // and the recovery is reported once.
    token = ownToken;
    for (let i = 0; JSON.parse(readFileSync(path, "utf8")).messagesReceived === before.messagesReceived && i < 400; i++) await Bun.sleep(5);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.messagesReceived).toBe(before.messagesReceived + 3);
    const recovered = diagnostic.mock.calls.filter(([line]) => String(line).includes("refresh recovered"));
    expect(recovered).toHaveLength(1);
    expect(String(recovered[0][0])).toContain(`[relay] host state record ${path} refresh recovered; writes resumed`);
    expect(alive).toBe(true);
  } finally {
    token = ownToken;
    await stop?.();
    for (let i = 0; handler && !detached && i < 200; i++) await Bun.sleep(10);
    connect.mockRestore();
    diagnostic.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each([false, true])("an inbound write stops retrying for another connection with unreadable self token %j", async (unreadableToken) => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-inbound-other-779-"));
  const savedEnv = savedRelayEnv();
  const ownToken = processStartToken(process.pid) ?? "test:self";
  let token: string | null = ownToken;
  let stop: (() => Promise<void>) | undefined;
  let handler: Parameters<TransportChannel["onMessage"]>[0] | undefined;
  let alive = true;
  let detached = false;
  const channel: TransportChannel = {
    async send() {},
    onMessage(callback) { handler = callback; },
    offMessage() { detached = true; },
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch, { testHooks: { startToken: () => token } });
    for (let i = 0; !handler && i < 200; i++) await Bun.sleep(5);
    expect(handler).toBeDefined();
    await Bun.sleep(20);
    const path = hostStatePath(branch);
    const before = JSON.parse(readFileSync(path, "utf8"));
    const original = readFileSync(path);
    token = unreadableToken ? null : ownToken;
    diagnostic.mockClear();
    // Replace the record before the scheduled inbound write runs: the write
    // sees another connection's id and ends its retries.
    handler!({ type: MSG_HEARTBEAT, seq: 0, ts: new Date().toISOString(), body: {} });
    writeFileSync(path, JSON.stringify({ ...before, connectionId: "other-conn", startToken: ownToken }));
    await Bun.sleep(20);
    expect(diagnostic.mock.calls.filter(([line]) => String(line).includes("not refreshed"))).toHaveLength(0);
    expect(readFileSync(path)).toEqual(Buffer.from(JSON.stringify({ ...before, connectionId: "other-conn", startToken: ownToken })));
    token = ownToken;
    // Restore our record; a pending retry would write the inbound update here.
    writeFileSync(path, original);
    await Bun.sleep(300);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
  } finally {
    token = ownToken;
    await stop?.();
    for (let i = 0; handler && !detached && i < 200; i++) await Bun.sleep(10);
    connect.mockRestore();
    diagnostic.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

for (const repeatedStop of [false, true]) {
  test(repeatedStop
    ? "a successful stop does not inspect a replacement record when called again"
    : "an older connection stop preserves a replacement record from the same process", async () => {
    const root = mkdtempSync(join(tmpdir(), "tps-relay-owner-779-"));
    const savedEnv = savedRelayEnv();
    const stops: Array<() => Promise<void>> = [];
    const channels: Array<{ attached: boolean; detached: boolean }> = [];
    const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
      const state = { attached: false, detached: false };
      channels.push(state);
      let alive = true;
      return {
        async send() {},
        onMessage() { state.attached = true; },
        offMessage() { state.detached = true; },
        async close() { alive = false; },
        isAlive() { return alive; },
        peerFingerprint() { return "remote"; },
      };
    });
    try {
      const branch = await prepareBranch(root);
      const path = hostStatePath(branch);
      const start = async () => {
        stops.push(await connectAndKeepAlive(branch));
        for (let i = 0; i < 200 && !channels.at(-1)?.attached; i++) await Bun.sleep(5);
        expect(channels.at(-1)?.attached).toBe(true);
        return JSON.parse(readFileSync(path, "utf8"));
      };
      const first = await start();
      expect(first.connectionId).toEqual(expect.any(String));
      if (repeatedStop) {
        await Promise.all([stops[0]!(), stops[0]!()]);
        expect(existsSync(path)).toBe(false);
      }
      const replacement = await start();
      expect(replacement.pid).toBe(first.pid);
      expect(replacement.connectionId).not.toBe(first.connectionId);
      const bytes = readFileSync(path, "utf8");
      const inspect = spyOn(fs, "lstatSync");
      try {
        await stops[0]!();
        if (repeatedStop) expect(inspect.mock.calls.filter(([target]) => target === path)).toHaveLength(0);
        expect(existsSync(path), "replacement record survives old stop").toBe(true);
        expect(readFileSync(path, "utf8")).toBe(bytes);
      } finally {
        inspect.mockRestore();
      }
      await stops[1]!();
      expect(existsSync(path)).toBe(false);
    } finally {
      try {
        for (const stop of stops) await stop();
        for (let i = 0; i < 200 && channels.some((channel) => channel.attached && !channel.detached); i++) await Bun.sleep(10);
        expect(channels.some((channel) => channel.attached && !channel.detached)).toBe(false);
      } finally {
        connect.mockRestore();
        restoreRelayEnv(savedEnv);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

for (const kind of ["refresh", "inbound"] as const) {
  test(`an older connection's ${kind} write leaves a replacement record intact`, async () => {
    const root = mkdtempSync(join(tmpdir(), `tps-relay-owner-${kind}-779-`));
    const savedEnv = savedRelayEnv();
    const stops: Array<() => Promise<void>> = [];
    const channels: Array<{ attached: boolean; detached: boolean; handler?: Parameters<TransportChannel["onMessage"]>[0] }> = [];
    const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
      const state: { attached: boolean; detached: boolean; handler?: Parameters<TransportChannel["onMessage"]>[0] } = { attached: false, detached: false };
      channels.push(state);
      let alive = true;
      return {
        async send() {},
        onMessage(callback) { state.attached = true; state.handler = callback; },
        offMessage() { state.detached = true; },
        async close() { alive = false; },
        isAlive() { return alive; },
        peerFingerprint() { return "remote"; },
      };
    });
    const gate = deferred<void>();
    let probeCount = 0;
    const server = kind === "refresh"
      ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async () => {
          probeCount++;
          // Hold the first connection's health probe until the replacement has
          // claimed the record; later probes answer immediately.
          if (probeCount === 1) await gate.promise;
          return new Response("ok");
        },
      })
      : undefined;
    try {
      const branch = await prepareBranch(root);
      if (server) registerService("host-a", `http://127.0.0.1:${server.port}/`);
      const path = hostStatePath(branch);
      const start = async () => {
        stops.push(await connectAndKeepAlive(branch));
        for (let i = 0; i < 200 && !channels.at(-1)?.attached; i++) await Bun.sleep(5);
        expect(channels.at(-1)?.attached).toBe(true);
        return JSON.parse(readFileSync(path, "utf8"));
      };
      const first = await start();
      expect(first.connectionId).toEqual(expect.any(String));
      if (server) {
        for (let i = 0; i < 200 && probeCount < 1; i++) await Bun.sleep(5);
        expect(probeCount).toBe(1);
      }
      const replacement = await start();
      expect(replacement.connectionId).not.toBe(first.connectionId);
      // Let the replacement's own health probe land, so its record is at rest.
      let atRest = replacement;
      const ready = () => atRest.connectionId === replacement.connectionId
        && Array.isArray(atRest.services)
        && atRest.services.length === (server ? 1 : 0);
      for (let i = 0; i < 400 && !ready(); i++) {
        await Bun.sleep(5);
        atRest = JSON.parse(readFileSync(path, "utf8"));
      }
      expect(ready()).toBe(true);
      const bytes = readFileSync(path, "utf8");
      if (server) {
        gate.resolve();
        await Bun.sleep(100);
      } else {
        channels[0]!.handler!({ type: MSG_HEARTBEAT, seq: 1, ts: new Date().toISOString(), body: {} });
        await Bun.sleep(100);
      }
      expect(readFileSync(path, "utf8"), "replacement record after the older connection's write").toBe(bytes);
      await stops[0]!();
      expect(existsSync(path), "replacement record survives the older stop").toBe(true);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      try {
        for (const stop of stops) await stop();
        for (let i = 0; i < 200 && channels.some((channel) => channel.attached && !channel.detached); i++) await Bun.sleep(10);
      } finally {
        server?.stop(true);
        connect.mockRestore();
        restoreRelayEnv(savedEnv);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
}
