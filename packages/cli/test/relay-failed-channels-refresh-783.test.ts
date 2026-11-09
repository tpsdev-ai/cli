import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateLockRoot, hostStatePath } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { mailLockPath } from "../src/utils/mail-lock.js";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import type { TransportChannel } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

afterEach(() => { mock.restore(); });

/** The real timer, captured before any test replaces globalThis.setTimeout. */
const realSetTimeout = globalThis.setTimeout;

/** Reconnect waits run on a short real timer. */
const TEST_RECONNECT_BACKOFF_MS = 100;

function fastReconnectBackoff() {
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof delay === "number" && delay >= 4_000 && delay <= 60_000) {
      return realSetTimeout(callback, TEST_RECONNECT_BACKOFF_MS, ...args);
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
}

/** A microtask backoff with an immediate connect fake keeps the retry chain off the timer phase; this real-timer yield keeps it reachable. */
function yieldRealTimer(): Promise<void> {
  return new Promise<void>((resolve) => { realSetTimeout(resolve, 1); });
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

const MAX_RETAINED_FAILED_CHANNELS = 4;

test("the retained close bound matches relay's private constant", () => {
  const source = readFileSync(new URL("../src/utils/relay.ts", import.meta.url), "utf8");
  expect(source.match(/const MAX_RETAINED_FAILED_CHANNELS = (\d+);/)?.[1])
    .toBe(String(MAX_RETAINED_FAILED_CHANNELS));
});

test("stop() retries the retained bound of channel closes after many reconnect failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-failed-channel-bound-783-"));
  const savedEnv = savedRelayEnv();
  const failures = 12;
  let connects = 0;
  let closes = 0;
  let stopping = false;
  let inFlightConnectResidual = 0;
  const fastBackoff = fastReconnectBackoff();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    await yieldRealTimer();
    const connectedAfterStop = stopping;
    return {
      async send() { throw new Error("initial heartbeat refused"); },
      onMessage() {},
      offMessage() {},
      async close() {
        if (connectedAfterStop) inFlightConnectResidual++;
        closes++;
        throw new Error("close refused persistently");
      },
      isAlive() { return true; },
      peerFingerprint() { return "remote"; },
    };
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const branch = await prepareBranch(root);
    const started = performance.now();
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; closes < failures && i < 2_000; i++) await Bun.sleep(5);
    // Spaced retries cannot exceed elapsed/backoff, plus the first attempt and one in flight.
    await Bun.sleep(20);
    expect(connects).toBeGreaterThanOrEqual(failures);
    expect(connects).toBeLessThanOrEqual(2 + Math.floor((performance.now() - started) / TEST_RECONNECT_BACKOFF_MS));
    expect(closes).toBeGreaterThanOrEqual(failures);
    const beforeStop = closes;
    const stopStarted = performance.now();
    stopping = true;
    await expect(stop()).rejects.toMatchObject({ name: "HostChannelCloseError" });
    expect(performance.now() - stopStarted).toBeLessThan(5_000);
    expect(closes, "eviction must bound stop's close retries").toBeLessThanOrEqual(connects + MAX_RETAINED_FAILED_CHANNELS);
    expect(inFlightConnectResidual).toBeLessThanOrEqual(1);
    expect(closes - beforeStop - inFlightConnectResidual, "retained retries excluding the in-flight connect close")
      .toBe(MAX_RETAINED_FAILED_CHANNELS);
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
  let closes = 0;
  let stopPhase = false;
  const fastBackoff = fastReconnectBackoff();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    connects++;
    await yieldRealTimer();
    const id = connects;
    return {
      async send() { throw new Error("initial heartbeat refused"); },
      onMessage() {},
      offMessage() {},
      async close() {
        // The first channel is evicted while still unclosed; every channel
        // still retained closes on stop's retry.
        if (stopPhase && id !== 1) return;
        closes++;
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
    const started = performance.now();
    stop = await connectAndKeepAlive(branch);
    for (let i = 0; connects <= failures && i < 2_000; i++) await Bun.sleep(5);
    // Spaced retries cannot exceed elapsed/backoff, plus the first attempt and one in flight.
    expect(connects).toBeGreaterThan(failures);
    expect(connects).toBeLessThanOrEqual(2 + Math.floor((performance.now() - started) / TEST_RECONNECT_BACKOFF_MS));
    expect(closes).toBeGreaterThanOrEqual(failures);
    await Bun.sleep(20);
    expect(connects).toBeLessThanOrEqual(2 + Math.floor((performance.now() - started) / TEST_RECONNECT_BACKOFF_MS));
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
    const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
      await yieldRealTimer();
      return channel;
    });
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
      expect(error).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(closes).toBe(outcome === "rejects" ? 2 : 1);
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

for (const closePath of ["reconnect", "graceful"] as const) {
  for (const rejectionTiming of ["before stop", "during stop"] as const) {
    for (const retry of ["resolves", "rejects"] as const) {
      test(`${closePath} close rejects ${rejectionTiming}; stop retry ${retry}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "tps-relay-close-retry-828-"));
        const savedEnv = savedRelayEnv();
        let rejectClose!: () => void;
        let closeStarted!: () => void;
        const closing = new Promise<void>((_resolve, reject) => {
          rejectClose = () => reject(new Error("first close refused"));
        });
        const started = new Promise<void>((resolve) => { closeStarted = resolve; });
        let closes = 0;
        let handlers = 0;
        const channel: TransportChannel = {
          async send() {
            if (closePath === "reconnect") throw new Error("initial heartbeat refused");
          },
          onMessage() { handlers++; },
          offMessage() {},
          async close() {
            if (++closes === 1) {
              closeStarted();
              await closing;
            } else if (retry === "rejects") {
              throw new Error("retry close refused");
            }
          },
          isAlive() { return false; },
          peerFingerprint() { return "remote"; },
        };
        const diagnostic = spyOn(console, "error").mockImplementation(() => {});
        const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
          await yieldRealTimer();
          return channel;
        });
        let stop: (() => Promise<void>) | undefined;
        try {
          const branch = await prepareBranch(root);
          const path = hostStatePath(branch);
          stop = await connectAndKeepAlive(branch);
          await started;
          expect(handlers).toBe(closePath === "graceful" ? 2 : 0);
          expect(existsSync(path)).toBe(true);
          if (rejectionTiming === "before stop") {
            rejectClose();
            await yieldRealTimer();
            expect(diagnostic).toHaveBeenCalledTimes(1);
          }
          let stopSettled = false;
          const stopping = stop().then(
            () => { stopSettled = true; return null; },
            (error: unknown) => { stopSettled = true; return error; },
          );
          if (rejectionTiming === "during stop") {
            await Bun.sleep(10);
            const settledBeforeClose = stopSettled;
            rejectClose();
            expect(settledBeforeClose).toBe(false);
          }
          const error = await stopping;
          expect(closes).toBe(2);
          expect(connect).toHaveBeenCalledTimes(1);
          if (retry === "resolves") {
            expect(error).toBeNull();
            expect(existsSync(path)).toBe(false);
            expect(diagnostic).toHaveBeenCalledTimes(1);
          } else {
            expect(error).toMatchObject({ name: "HostChannelCloseError" });
            expect(existsSync(path)).toBe(true);
            expect(diagnostic).toHaveBeenCalledTimes(2);
          }
        } finally {
          rejectClose();
          await stop?.().catch(() => {});
          connect.mockRestore();
          diagnostic.mockRestore();
          restoreRelayEnv(savedEnv);
          rmSync(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  }
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
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockImplementation(async () => {
    await yieldRealTimer();
    return channel;
  });
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
