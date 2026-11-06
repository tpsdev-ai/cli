import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateLockRoot, hostStatePath } from "../src/utils/connection-state.js";
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
  process.env.TPS_VAULT_KEY = "relay-failed-channels-test";
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

test("stop() attempts at most the retained bound of channel closes after many reconnect failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-failed-channel-bound-783-"));
  const savedEnv = savedRelayEnv();
  const failures = 12;
  const retainedBound = 4;
  let connects = 0;
  let closes = 0;
  const never = new Promise<TransportChannel>(() => {});
  const realSetTimeout = globalThis.setTimeout;
  // The reconnect backoff is 4 s at its shortest and grows to 60 s. Run those
  // waits as microtasks so the test reaches many failures without waiting.
  const fastBackoff = spyOn(globalThis, "setTimeout").mockImplementation(((
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
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    if (connects > failures) return never;
    return {
      async send() { throw new Error("initial heartbeat refused"); },
      onMessage() {},
      offMessage() {},
      async close() { closes++; throw new Error("close refused persistently"); },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    };
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const branch = await prepareBranch(root);
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; closes < failures && i < 2_000; i++) await Bun.sleep(5);
    expect(closes).toBe(failures);
    const beforeStop = closes;
    const started = performance.now();
    await expect(stop()).rejects.toMatchObject({ name: "HostChannelCloseError" });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(closes - beforeStop).toBeGreaterThan(0);
    expect(closes - beforeStop).toBeLessThanOrEqual(retainedBound);
    expect(diagnostic).toHaveBeenCalled();
  } finally {
    await stop?.().catch(() => {});
    connect.mockRestore();
    diagnostic.mockRestore();
    fastBackoff.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an evicted channel left unclosed keeps the host record and reports the close failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-evicted-close-783-"));
  const savedEnv = savedRelayEnv();
  const failures = 5;
  let connects = 0;
  let stopPhase = false;
  const never = new Promise<TransportChannel>(() => {});
  const realSetTimeout = globalThis.setTimeout;
  const fastBackoff = spyOn(globalThis, "setTimeout").mockImplementation(((
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
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    if (connects > failures) return never;
    const id = connects;
    return {
      async send() { throw new Error("initial heartbeat refused"); },
      onMessage() {},
      offMessage() {},
      async close() {
        // The first channel is evicted while still unclosed; every channel
        // still retained closes on stop's retry.
        if (stopPhase && id !== 1) return;
        throw new Error("close refused");
      },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    };
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const branch = await prepareBranch(root);
    const path = hostStatePath(branch);
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; connects <= failures && i < 2_000; i++) await Bun.sleep(5);
    expect(connects).toBeGreaterThan(failures);
    expect(existsSync(path)).toBe(true);
    stopPhase = true;
    await expect(stop()).rejects.toMatchObject({ name: "HostChannelCloseError" });
    expect(existsSync(path)).toBe(true);
    expect(diagnostic).toHaveBeenCalled();
  } finally {
    await stop?.().catch(() => {});
    connect.mockRestore();
    diagnostic.mockRestore();
    fastBackoff.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

for (const outcome of ["rejects", "resolves"] as const) {
  test(`stop() waits for a pending reconnect close that ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tps-relay-pending-close-783-"));
    const savedEnv = savedRelayEnv();
    let settleClose!: () => void;
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve, reject) => {
      settleClose = outcome === "rejects" ? () => reject(new Error("close refused")) : resolve;
    });
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    let closes = 0;
    const channel: TransportChannel = {
      async send() { throw new Error("initial heartbeat refused"); },
      onMessage() {},
      offMessage() {},
      async close() {
        if (++closes > 1) return;
        closeStarted();
        await closing;
      },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    };
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
    let stop: (() => Promise<void>) | undefined;
    try {
      const branch = await prepareBranch(root);
      const path = hostStatePath(branch);
      stop = await connectAndKeepAlive(branch);
      await started;
      expect(existsSync(path)).toBe(true);
      let stopSettled = false;
      const stopping = stop().then(
        () => { stopSettled = true; return null; },
        (error: unknown) => { stopSettled = true; return error; },
      );
      await Bun.sleep(10);
      const settledBeforeClose = stopSettled;
      settleClose();
      const error = await stopping;
      if (outcome === "rejects") {
        expect(error).toMatchObject({ name: "HostChannelCloseError" });
        expect(existsSync(path)).toBe(true);
      } else {
        expect(error).toBeNull();
        expect(existsSync(path)).toBe(false);
      }
      expect(settledBeforeClose).toBe(false);
    } finally {
      settleClose();
      await stop?.().catch(() => {});
      connect.mockRestore();
      diagnostic.mockRestore();
      restoreRelayEnv(savedEnv);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("a failed host record refresh is reported once per connection until a write succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-refresh-report-783-"));
  const savedEnv = savedRelayEnv();
  const realSetInterval = globalThis.setInterval;
  let heartbeat: (() => Promise<void>) | undefined;
  let alive = true;
  const channel: TransportChannel = {
    async send() {},
    onMessage() {},
    offMessage() {},
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  // Capture the heartbeat callback so the test can drive its persist without
  // waiting for the 30 s interval; every other interval passes through.
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 30_000) {
      heartbeat = callback as () => Promise<void>;
      return 0;
    }
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
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
    for (let i = 0; (!existsSync(path) || !heartbeat) && i < 200; i++) await Bun.sleep(5);
    expect(heartbeat).toBeDefined();
    // Let the initial health probe finish so it cannot add a line of its own.
    await Bun.sleep(20);
    diagnostic.mockClear();

    lockRoot = holdHostLock(path);
    await heartbeat!();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0][0]).toContain(path);
    await heartbeat!();
    expect(diagnostic).toHaveBeenCalledTimes(1);

    releaseLock();
    await heartbeat!();
    expect(diagnostic).toHaveBeenCalledTimes(1);

    lockRoot = holdHostLock(path);
    await heartbeat!();
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(diagnostic.mock.calls[1][0]).toContain(path);

    releaseLock();
    await heartbeat!();
  } finally {
    releaseLock();
    await stop?.();
    intervals.mockRestore();
    diagnostic.mockRestore();
    connect.mockRestore();
    restoreRelayEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
