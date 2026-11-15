/**
 * cli#921 — the branch daemon's shutdown path cancels the outbox retry timer,
 * and the retry's pickTarget lambda uses the live host channel.
 *
 * The daemon runs in-process under a temp HOME; the listener is captured
 * through a spy so the test reads the port it actually bound.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBranch, writeBranchConf } from "../src/commands/branch.js";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
import { OutboxYoungRetryScheduler } from "../src/utils/outbox.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import * as tcp from "../src/utils/noise-ik-transport.js";
import type { TransportChannel, TransportServer, TpsMessage } from "../src/utils/transport.js";
import { MSG_HEARTBEAT, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";

afterEach(() => {
  mock.restore();
});

async function waitUntil(ready: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function exchangeHeartbeat(channel: TransportChannel, seq: number): Promise<TpsMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.offMessage(handler);
    };
    const handler = (received: TpsMessage) => {
      if (received.type !== MSG_HEARTBEAT || received.seq !== seq) return;
      cleanup();
      resolve(received);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("heartbeat reply timeout"));
    }, 5000);
    channel.onMessage(handler);
    channel.send({ type: MSG_HEARTBEAT, seq, ts: new Date().toISOString(), body: {} }).catch((error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

describe("branch daemon outbox retry lifecycle", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let server: TransportServer | undefined;
  let channel: TransportChannel | undefined;
  // The daemon's side of the connection, captured from onConnection.
  let serverChannel: TransportChannel | undefined;
  let baselineSignals: { sigterm: Function[]; sigint: Function[] };
  let retryRuns: Array<() => void>;
  let retrySchedulers: OutboxYoungRetryScheduler[];
  let watchers: fs.FSWatcher[];
  // The real fs.watch, taken before any test spies on it.
  const realWatch = fs.watch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"]) {
      savedEnv[key] = process.env[key];
    }
    root = mkdtempSync(join(tmpdir(), "tps-branch-outbox-retry-"));
    process.env.HOME = root;
    process.env.TPS_ROOT = join(root, ".tps");
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    process.env.TPS_AGENT_ID = "agent-a";
    process.env.TPS_VAULT_KEY = "branch-outbox-retry-test";
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    mkdirSync(process.env.TPS_IDENTITY_DIR, { recursive: true });
    server = undefined;
    channel = undefined;
    serverChannel = undefined;
    retryRuns = [];
    retrySchedulers = [];
    watchers = [];
    baselineSignals = { sigterm: process.listeners("SIGTERM"), sigint: process.listeners("SIGINT") };
  });

  afterEach(async () => {
    try {
      await channel?.close();
    } catch {
      /* best effort */
    }
    for (const watcher of watchers.splice(0)) watcher.close();
    try {
      await server?.close();
    } catch {
      /* best effort */
    }
    for (const [signal, before] of [["SIGTERM", baselineSignals.sigterm], ["SIGINT", baselineSignals.sigint]] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before.includes(listener)) process.removeListener(signal, listener);
      }
    }
    fsCleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function fsCleanup(): void {
    rmSync(root, { recursive: true, force: true });
  }

  function outboxNewDir(): string {
    return join(root, ".tps", "outbox", "new");
  }

  function writeYoungFile(name: string, content: string): void {
    mkdirSync(outboxNewDir(), { recursive: true });
    writeFileSync(join(outboxNewDir(), name), content, "utf-8");
  }

  async function startDaemon(): Promise<{ port: number; shutdown: () => Promise<void> }> {
    const branchKey = generateKeyPair();
    const hostKey = generateKeyPair();
    saveKeyPair(branchKey, process.env.TPS_IDENTITY_DIR!, "branch");
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(hostKey.encryption.publicKey).toString("base64url") }),
    );
    writeBranchConf(0, "127.0.0.1", "tcp", undefined, "agent-a");

    spyOn(fs, "watch").mockImplementation(((filename: fs.PathLike, listener: fs.WatchListener<string>) => {
      const watcher = realWatch(filename, listener);
      watchers.push(watcher);
      return watcher;
    }) as typeof fs.watch);

    const originalListen = tcp.listenForHost;
    spyOn(tcp, "listenForHost").mockImplementation((async (...args: Parameters<typeof originalListen>) => {
      const actual = await originalListen(...args);
      server = actual;
      const originalOnConnection = actual.onConnection.bind(actual);
      spyOn(actual, "onConnection").mockImplementation((handler: (channel: TransportChannel) => void) => {
        originalOnConnection((opened) => {
          serverChannel = opened;
          handler(opened);
        });
      });
      return actual;
    }) as typeof tcp.listenForHost);

    let startupError: unknown;
    void runBranch({ action: "start" }).catch((error: unknown) => {
      startupError = error;
    });
    await waitUntil(() => server !== undefined || startupError !== undefined, "the branch listener");
    if (startupError) throw startupError;
    if (!server) throw new Error("listener did not start");
    const port = server.port();
    if (!port) throw new Error("listener did not report its bound port");

    const client = new NoiseIkTransport(hostKey);
    channel = await client.connect({ host: "127.0.0.1", port, branchId: "agent-a", hostPublicKey: branchKey.encryption.publicKey });

    const added = process.listeners("SIGTERM").filter((listener) => !baselineSignals.sigterm.includes(listener));
    if (added.length !== 1) throw new Error(`expected one SIGTERM listener, got ${added.length}`);
    const shutdown = async (): Promise<void> => {
      await (added[0] as () => Promise<void>)();
    };
    return { port, shutdown };
  }

  function watchRetries(): void {
    const originalObserve = OutboxYoungRetryScheduler.prototype.observe;
    spyOn(OutboxYoungRetryScheduler.prototype, "observe").mockImplementation(function (
      this: OutboxYoungRetryScheduler,
      skippedYoung: number,
      run: () => void,
    ): void {
      const wasPending = this.pending;
      originalObserve.call(this, skippedYoung, run);
      if (skippedYoung > 0 && !wasPending) {
        retryRuns.push(run);
        retrySchedulers.push(this);
      }
    });
  }

  test("shutdown cancels a pending outbox retry timer", async () => {
    watchRetries();
    const { shutdown } = await startDaemon();
    const deliveries: TpsMessage[] = [];
    channel!.onMessage((message) => {
      if (message.type === MSG_MAIL_DELIVER) deliveries.push(message);
    });

    writeYoungFile("young-shutdown.json", "{");
    await exchangeHeartbeat(channel!, 1);
    await waitUntil(() => retrySchedulers.length === 1, "a scheduled retry");
    const scheduler = retrySchedulers[0]!;
    expect(scheduler.pending).toBe(true);
    expect(deliveries).toEqual([]);

    const originalCancel = OutboxYoungRetryScheduler.prototype.cancel;
    let pendingBeforeCancel: boolean | undefined;
    let cancelledScheduler: OutboxYoungRetryScheduler | undefined;
    const cancelSpy = spyOn(OutboxYoungRetryScheduler.prototype, "cancel").mockImplementation(function (
      this: OutboxYoungRetryScheduler,
    ): void {
      pendingBeforeCancel = this.pending;
      cancelledScheduler = this;
      originalCancel.call(this);
    });

    let exitCode: number | undefined;
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);

    await shutdown();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(pendingBeforeCancel).toBe(true);
    expect(cancelledScheduler).toBe(scheduler);
    expect(scheduler.pending).toBe(false);
    expect(exitCode).toBe(0);
  }, 20_000);

  test("a retry sends through pickTarget's live host channel and sends nothing once that channel closes", async () => {
    watchRetries();
    const { shutdown } = await startDaemon();
    const deliveries: TpsMessage[] = [];
    channel!.onMessage((message) => {
      if (message.type === MSG_MAIL_DELIVER) deliveries.push(message);
    });

    writeYoungFile("young-retry.json", "{");
    await exchangeHeartbeat(channel!, 1);
    await waitUntil(() => retryRuns.length === 1, "a scheduled retry");

    // Close the outbox watcher first: otherwise the completion below triggers a
    // pass of its own and the delivery would not prove the retry's pickTarget.
    for (const watcher of watchers.splice(0)) watcher.close();
    writeFileSync(
      join(outboxNewDir(), "young-retry.json"),
      JSON.stringify({ id: "retry-1", to: "host-a", from: "agent-a", body: "complete", timestamp: new Date().toISOString() }),
      "utf-8",
    );
    retryRuns[0]!();
    await waitUntil(() => deliveries.length === 1, "the retried delivery");
    expect(deliveries[0]!.seq).toBe(0);
    expect((deliveries[0]!.body as { id: string }).id).toBe("retry-1");

    // Stop the scheduled timer, then drop the connection. The daemon keeps its
    // channel reference but that channel is no longer alive, so the retry has
    // to go through pickTarget's isAlive() guard.
    retrySchedulers[0]!.cancel();
    await channel!.close();
    const deadChannel = serverChannel!;
    await waitUntil(() => !serverChannel!.isAlive(), "the server-side channel to close");

    writeYoungFile(
      "young-retry-2.json",
      JSON.stringify({ id: "retry-2", to: "host-a", from: "agent-a", body: "complete", timestamp: new Date().toISOString() }),
    );
    const sendSpy = spyOn(deadChannel, "send");
    retryRuns[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendSpy).not.toHaveBeenCalled();
    expect(deliveries.length).toBe(1);
    expect(readdirSync(outboxNewDir())).toContain("young-retry-2.json");

    let exitCode: number | undefined;
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);
    await shutdown();
    expect(exitCode).toBe(0);
  }, 20_000);
});
