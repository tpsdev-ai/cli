import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateLockRoot, hostStatePath, readHostState } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { mailLockPath } from "../src/utils/mail-lock.js";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import type { TransportChannel } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

afterEach(() => { mock.restore(); });

const savedRelayEnv = () => ({ HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
  TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
  TPS_VAULT_KEY: process.env.TPS_VAULT_KEY });

function restoreRelayEnv(saved: ReturnType<typeof savedRelayEnv>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Register a branch and its remote.json under an isolated root. */
async function prepareBranch(root: string): Promise<string> {
  process.env.HOME = root;
  process.env.TPS_ROOT = root;
  process.env.TPS_IDENTITY_DIR = join(root, "identity");
  process.env.TPS_REGISTRY_DIR = join(root, "registry");
  process.env.TPS_VAULT_KEY = "relay-host-connection-test";
  await initHostIdentity();
  const branch = "remote";
  const keys = generateKeyPair();
  registerBranch(branch, keys.signing.publicKey, undefined, keys.encryption.publicKey);
  const branchDir = join(root, ".tps", "branch-office", branch);
  mkdirSync(branchDir, { recursive: true });
  writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));
  return branch;
}

/** Hold a host record's lock from this process, so the next write refuses. */
function holdHostLock(path: string): string {
  const root = hostStateLockRoot(path);
  const dir = mailLockPath(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, startToken: null }));
  return root;
}

/** Run reconnect waits as microtasks so a test reaches a later connect quickly. */
function fastReconnectBackoff() {
  const realSetTimeout = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof delay === "number" && delay >= 4_000 && delay <= 60_000) {
      queueMicrotask(() => callback(...args));
      return 0;
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
}

test("a normal disconnect whose close rejects keeps the record and stop reports it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-disconnect-reject-791-"));
  const savedEnv = savedRelayEnv();
  let closes = 0;
  let closeStarted!: () => void;
  const started = new Promise<void>((resolve) => { closeStarted = resolve; });
  const never = new Promise<TransportChannel>(() => {});
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() {
      closes++;
      closeStarted();
      throw new Error("close refused");
    },
    isAlive() { return false; },
    peerFingerprint() { return "remote"; },
  };
  const backoff = fastReconnectBackoff();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  let connects = 0;
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    return connects === 1 ? channel : never;
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    await started;
    // Let the disconnect path finish and reach the next connect, so stop() is
    // not merely racing the close that is still in flight.
    for (let i = 0; connects < 2 && i < 400; i++) await Bun.sleep(5);
    expect(connects).toBeGreaterThanOrEqual(2);
    expect(readHostState(branch)).not.toBeNull();
    await expect(stop()).rejects.toMatchObject({ name: "HostChannelCloseError" });
    expect(readHostState(branch)).not.toBeNull();
    expect(closes).toBeGreaterThanOrEqual(2);
    expect(diagnostic.mock.calls.some((call) => String(call[0]).includes(path))).toBe(true);
  } finally {
    await stop?.().catch(() => {});
    connect.mockRestore();
    diagnostic.mockRestore();
    backoff.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a normal disconnect whose close resolves lets stop clear the record", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-disconnect-resolve-791-"));
  const savedEnv = savedRelayEnv();
  let closeStarted!: () => void;
  const started = new Promise<void>((resolve) => { closeStarted = resolve; });
  const never = new Promise<TransportChannel>(() => {});
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() { closeStarted(); },
    isAlive() { return false; },
    peerFingerprint() { return "remote"; },
  };
  const backoff = fastReconnectBackoff();
  let connects = 0;
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    return connects === 1 ? channel : never;
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch);
    await started;
    expect(readHostState(branch)).not.toBeNull();
    await stop();
    expect(readHostState(branch)).toBeNull();
  } finally {
    await stop?.().catch(() => {});
    connect.mockRestore();
    backoff.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an initial health probe write failure reports path and reason without record contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-initial-health-791-"));
  const savedEnv = savedRelayEnv();
  let resolveFetch!: (value: Response) => void;
  const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => pendingFetch) as unknown as typeof fetch);
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() {},
    isAlive() { return true; },
    peerFingerprint() { return "remote"; },
  };
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  const releaseLock = () => {
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    lockRoot = undefined;
  };
  try {
    const branch = await prepareBranch(root);
    writeFileSync(join(root, "branch-services.json"), JSON.stringify({
      "service-a": { url: "http://127.0.0.1:1", localPort: 1 },
    }));
    stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    for (let i = 0; fetchSpy.mock.calls.length === 0 && i < 200; i++) await Bun.sleep(5);
    expect(fetchSpy).toHaveBeenCalled();
    const record = readHostState(branch);
    expect(record).not.toBeNull();
    lockRoot = holdHostLock(path);
    resolveFetch(new Response("ok"));
    for (let i = 0; diagnostic.mock.calls.length === 0 && i < 400; i++) await Bun.sleep(5);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const line = String(diagnostic.mock.calls[0][0]);
    expect(line).toContain(path);
    expect(line).toContain("Host state record lock");
    expect(line).not.toContain(record!.connectedAt);
  } finally {
    releaseLock();
    await stop?.();
    fetchSpy.mockRestore();
    diagnostic.mockRestore();
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a periodic health probe write failure reports path and reason without record contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-periodic-health-791-"));
  const savedEnv = savedRelayEnv();
  const realSetInterval = globalThis.setInterval;
  let health: (() => Promise<void>) | undefined;
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5 * 60_000) {
      health = callback as () => Promise<void>;
      return 0;
    }
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() {},
    isAlive() { return true; },
    peerFingerprint() { return "remote"; },
  };
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  const releaseLock = () => {
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    lockRoot = undefined;
  };
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    for (let i = 0; ((readHostState(branch)?.services === undefined) || !health) && i < 200; i++) await Bun.sleep(5);
    expect(health).toBeDefined();
    await Bun.sleep(20);
    diagnostic.mockClear();
    const record = readHostState(branch);
    expect(record).not.toBeNull();
    lockRoot = holdHostLock(path);
    await health!();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const line = String(diagnostic.mock.calls[0][0]);
    expect(line).toContain(path);
    expect(line).toContain("Host state record lock");
    expect(line).not.toContain(record!.connectedAt);
  } finally {
    releaseLock();
    await stop?.();
    intervals.mockRestore();
    diagnostic.mockRestore();
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a connect-time host record write failure is reported before reconnecting", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-connect-write-791-"));
  const savedEnv = savedRelayEnv();
  const never = new Promise<TransportChannel>(() => {});
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() {},
    isAlive() { return true; },
    peerFingerprint() { return "remote"; },
  };
  const backoff = fastReconnectBackoff();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  let connects = 0;
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    return connects === 1 ? channel : never;
  });
  let stop: (() => Promise<void>) | undefined;
  let lockRoot: string | undefined;
  const releaseLock = () => {
    if (lockRoot) rmSync(lockRoot, { recursive: true, force: true });
    lockRoot = undefined;
  };
  try {
    const branch = await prepareBranch(root);
    const path = hostStatePath(branch);
    lockRoot = holdHostLock(path);
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; connects < 2 && i < 400; i++) await Bun.sleep(5);
    expect(connects).toBeGreaterThanOrEqual(2);
    const line = diagnostic.mock.calls.map((call) => String(call[0])).find((text) => text.includes("connect write failed"));
    expect(line).toBeDefined();
    expect(line).toContain(path);
    expect(line).toContain("Host state record lock");
    releaseLock();
    await stop();
  } finally {
    releaseLock();
    await stop?.().catch(() => {});
    connect.mockRestore();
    diagnostic.mockRestore();
    backoff.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
