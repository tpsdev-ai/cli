/**
 * cli#762: `office connect` runs the same checked shutdown on SIGTERM as on
 * SIGINT — the relay stops, the host record is cleared, and a failed clear is
 * reported with a non-zero exit.
 *
 * The command runs as its own process, from this tree's source, against a real
 * branch-side WebSocket listener on 127.0.0.1, under a scratch HOME and TMPDIR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnectShutdown } from "../src/commands/office.js";
import { hostStatePath } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { QUIET_NONO_CHECK_FLAG, SANDBOX_REQUIRED_FLAG } from "../src/utils/nono.js";
import type { TransportChannel, TransportServer } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

/** The CLI entry point, run from source so the test exercises this tree's command. */
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const BRANCH = "remote";

/** Each polling wait below passes one of these named deadlines; each deadline
 *  is below the per-test timeout. */
const CONNECT_DEADLINE_MS = 25_000;
const RECORD_DEADLINE_MS = 10_000;
const EXIT_DEADLINE_MS = 8_000;
const CHANNEL_CLOSE_DEADLINE_MS = 5_000;
const CLEANUP_DEADLINE_MS = 2_000;
const TEST_TIMEOUT_MS = 45_000;

const ENV_KEYS = ["HOME", "TMPDIR", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"];

type Exit = { code: number | null; signal: NodeJS.Signals | null };

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Poll (bounded) until `ready()` holds; the failure names what was awaited. */
async function waitFor(what: string, ready: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Set HOME and TMPDIR to `root`, and every TPS directory below it. */
function isolateEnv(root: string): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.HOME = root;
  process.env.TMPDIR = join(root, "tmp");
  process.env.TPS_ROOT = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
  process.env.TPS_IDENTITY_DIR = join(root, "identity");
  process.env.TPS_REGISTRY_DIR = join(root, "registry");
  process.env.TPS_VAULT_KEY = "office-connect-sigterm-test";
  process.env.TPS_BRANCH_NO_DAEMON = "1";
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Register the branch and point its remote.json at `port`. */
async function prepareBranch(root: string, port: number): Promise<void> {
  const keys = generateKeyPair();
  registerBranch(BRANCH, keys.signing.publicKey, undefined, keys.encryption.publicKey);
  const branchDir = join(root, ".tps", "branch-office", BRANCH);
  mkdirSync(branchDir, { recursive: true });
  writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }));
  const host = await initHostIdentity();
  server = await ws.listenForHostWs(keys, host.encryption.publicKey, port, () => {});
  server.onConnection((channel) => { connected = channel; });
}

/** Put a directory where the host record is, so its owner cannot be verified.
 *  The connector's heartbeat rewrite cannot rename over it; a write that lands
 *  between the removal and the mkdir makes the mkdir fail, so retry. */
async function replaceRecordWithDirectory(path: string): Promise<void> {
  const deadline = Date.now() + RECORD_DEADLINE_MS;
  for (;;) {
    try {
      rmSync(path, { force: true });
      mkdirSync(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

let root: string | undefined;
let savedEnv: Record<string, string | undefined> = {};
let server: TransportServer | undefined;
let connected: TransportChannel | undefined;
let child: ChildProcess | undefined;
let childClosed: Promise<Exit> | undefined;
let stdout = "";
let stderr = "";

/** Start `tps office connect` and wait for its connection and host record. */
/** The pid a host record file names, or null while it is absent or not yet whole. */
function recordPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof record.pid === "number" ? record.pid : null;
  } catch {
    return null;
  }
}

async function startConnect(): Promise<{ channel: TransportChannel; recordPath: string }> {
  const dir = root!;
  const port = await freePort();
  await prepareBranch(dir, port);

  const proc = spawn(
    process.execPath,
    [TPS_BIN, "office", "connect", BRANCH, SANDBOX_REQUIRED_FLAG, QUIET_NONO_CHECK_FLAG],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child = proc;
  stdout = "";
  stderr = "";
  childClosed = new Promise<Exit>((resolveExit) => {
    proc.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  proc.stdout!.setEncoding("utf8");
  proc.stderr!.setEncoding("utf8");
  proc.stdout!.on("data", (data: string) => { stdout += data; });
  proc.stderr!.on("data", (data: string) => { stderr += data; });

  await waitFor(
    "office connect to reach the relay",
    () => connected !== undefined || proc.exitCode !== null,
    CONNECT_DEADLINE_MS,
  );
  if (!connected) {
    throw new Error(`office connect exited before connecting (code ${proc.exitCode}):\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const recordPath = hostStatePath(BRANCH);
  await waitFor("the host record to name the connector process", () => recordPid(recordPath) === proc.pid, RECORD_DEADLINE_MS);
  return { channel: connected, recordPath };
}

/** Signal the connector and read its exit within the deadline. */
async function signalAndWait(signal: NodeJS.Signals): Promise<Exit> {
  child!.kill(signal);
  const result = await Promise.race([
    childClosed!,
    Bun.sleep(EXIT_DEADLINE_MS).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    child!.kill("SIGKILL");
    throw new Error(`office connect did not exit within ${EXIT_DEADLINE_MS} ms of ${signal}:\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return result;
}

afterEach(async () => {
  try {
    const running = child;
    child = undefined;
    if (running && running.exitCode === null && running.signalCode === null) running.kill("SIGKILL");
    if (childClosed) await Promise.race([childClosed, Bun.sleep(CLEANUP_DEADLINE_MS)]);
    childClosed = undefined;
  } finally {
    try {
      const activeServer = server;
      server = undefined;
      await activeServer?.close();
      connected = undefined;
    } finally {
      try {
        restoreEnv(savedEnv);
        savedEnv = {};
      } finally {
        const dir = root;
        root = undefined;
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

describe("tps office connect checked shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} exits 0 with the relay stopped and the host record cleared`, async () => {
      root = mkdtempSync(join(tmpdir(), "tps-connect-sigterm-762-"));
      savedEnv = isolateEnv(root);
      const { channel } = await startConnect();

      const result = await signalAndWait(signal);
      expect(result).toEqual({ code: 0, signal: null });
      expect(existsSync(hostStatePath(BRANCH))).toBe(false);
      await waitFor("the relay's channel to close", () => !channel.isAlive(), CHANNEL_CLOSE_DEADLINE_MS);
      expect(stderr).not.toContain("Disconnect failed");
    }, TEST_TIMEOUT_MS);

    test(`${signal} reports a failed clear with a non-zero exit and keeps the record`, async () => {
      root = mkdtempSync(join(tmpdir(), "tps-connect-sigterm-762-"));
      savedEnv = isolateEnv(root);
      const { recordPath } = await startConnect();
      await replaceRecordWithDirectory(recordPath);

      const result = await signalAndWait(signal);
      expect(result.code).toBe(1);
      expect(stderr).toContain(`Disconnect failed: Host state record ${recordPath} is present but is not a regular file`);
      // The record entry is still the directory we put there.
      expect(statSync(recordPath).isDirectory()).toBe(true);
    }, TEST_TIMEOUT_MS);
  }
});

describe("createConnectShutdown", () => {
  test("a second signal while shutdown runs starts no second shutdown", async () => {
    let stops = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const exits: number[] = [];
    const shutdown = createConnectShutdown(
      async () => { stops++; await gate; },
      (code) => exits.push(code),
      () => {},
    );

    const first = shutdown();
    await shutdown();
    expect(stops).toBe(1);
    expect(exits).toEqual([]);

    release();
    await first;
    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("a failed stop is reported once and exits non-zero", async () => {
    const exits: number[] = [];
    const lines: string[] = [];
    const shutdown = createConnectShutdown(
      async () => { throw new Error("the record was kept"); },
      (code) => exits.push(code),
      (line) => lines.push(line),
    );

    await shutdown();
    expect(lines).toEqual(["Disconnect failed: the record was kept"]);
    expect(exits).toEqual([1]);
  });
});
