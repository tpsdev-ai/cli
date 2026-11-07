import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { writeBranchConf } from "../src/commands/branch.js";
import { branchStatePath, writeBranchState } from "../src/utils/connection-state.js";
import { QUIET_NONO_CHECK_FLAG } from "../src/utils/nono.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import { MSG_HEARTBEAT } from "../src/utils/wire-mail.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

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

async function connectHost(port: number, host: TpsKeyPair, branch: TpsKeyPair): Promise<TransportChannel> {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return await new NoiseIkTransport(host).connect({
        host: "127.0.0.1",
        port,
        branchId: "agent-a",
        hostPublicKey: branch.encryption.publicKey,
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

function exchange(channel: TransportChannel, message: TpsMessage, replyType: number): Promise<TpsMessage> {
  return new Promise((resolveReply, reject) => {
    const cleanup = () => { clearTimeout(timer); channel.offMessage(handler); };
    const handler = (received: TpsMessage) => {
      if (received.type !== replyType || received.seq !== message.seq) return;
      cleanup();
      resolveReply(received);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("reply timeout")); }, 5000);
    channel.onMessage(handler);
    channel.send(message).catch((error: unknown) => { cleanup(); reject(error); });
  });
}

describe("branch daemon state-write failure", () => {
  let root: string;
  let child: ChildProcess | undefined;
  let channel: TransportChannel | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    root = mkdtempSync(join(tmpdir(), "tps-branch-state-write-"));
    process.env.HOME = root;
    process.env.TPS_ROOT = join(root, ".tps");
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    process.env.TPS_AGENT_ID = "agent-a";
    process.env.TPS_VAULT_KEY = "branch-state-write-test";
  });

  afterEach(async () => {
    if (channel) {
      await channel.close().catch(() => {});
      channel = undefined;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await exited;
    }
    child = undefined;
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a state-write failure is logged and the heartbeat echo still runs", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
    );
    // A regular file in the connections directory's place makes the record
    // write fail for every uid, including root in CI.
    writeFileSync(join(process.env.TPS_ROOT!, "connections"), "not a directory");
    const port = await freePort();
    writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

    // The daemon runs under the same runtime as this test, so the failure
    // message is the one this process sees for the same construction.
    let writeFailure: string | undefined;
    try {
      writeBranchState({ connectedAt: "a", lastSeen: "b", messagesReceived: 0, messagesPushed: 0 });
    } catch (error) {
      writeFailure = error instanceof Error ? error.message : String(error);
    }
    expect(writeFailure).toBeDefined();

    const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
    delete env.TPS_BRANCH_DAEMON;
    child = spawn(process.execPath, [TPS_BIN, "branch", "start", QUIET_NONO_CHECK_FLAG], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    channel = await connectHost(port, host, branch);
    expect(channel.isAlive()).toBe(true);
    const echo = await exchange(channel, { type: MSG_HEARTBEAT, seq: 7, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
    expect(echo.seq).toBe(7);

    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").split("\n").filter((line) => line.includes("Branch state write failed"));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const prefix = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] /);
    expect(prefix).not.toBeNull();
    expect(line.slice(prefix![0].length)).toBe(`WARN: Branch state write failed at ${branchStatePath()}: ${writeFailure}`);
    expect(stderr).toBe("");
  }, 30_000);

  test("a state and log write failure is counted and reported in the next appended log line", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
    );
    const port = await freePort();
    writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

    const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
    delete env.TPS_BRANCH_DAEMON;
    child = spawn(process.execPath, [TPS_BIN, "branch", "start", QUIET_NONO_CHECK_FLAG], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    channel = await connectHost(port, host, branch);
    expect(channel.isAlive()).toBe(true);

    // The daemon is connected with a working log and state path; break both
    // now. A regular file in the connections directory's place and a directory
    // in the log file's place fail for every uid, including root in CI.
    const connections = join(process.env.TPS_ROOT!, "connections");
    rmSync(connections, { recursive: true, force: true });
    writeFileSync(connections, "not a directory");
    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    rmSync(logPath, { force: true });
    mkdirSync(logPath);

    for (const seq of [40, 41]) {
      const echoed = await exchange(channel, { type: MSG_HEARTBEAT, seq, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
      expect(echoed.seq).toBe(seq);
    }
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(stderr).toBe("");

    // Each broken heartbeat fails two appends: the state-write warning and the
    // outbox-drained line, so the two heartbeats lost four lines. Wait for the
    // daemon to finish the last heartbeat's trailing append attempt, then make
    // the log writable again; the same running daemon's next successful
    // append reports those four. The count is lost if the daemon exits or restarts.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    rmSync(logPath, { recursive: true, force: true });
    const appended = await exchange(channel, { type: MSG_HEARTBEAT, seq: 42, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
    expect(appended.seq).toBe(42);

    const entries = readFileSync(logPath, "utf-8").split("\n").filter((line) => line.length > 0);
    expect(entries[0]).toContain("(4 log lines lost)");
  }, 30_000);

  test("heartbeat echoes continue when the state and log paths fail after connect and the stderr pipe is closed", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
    );
    const port = await freePort();
    writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

    // The daemon runs the built CLI (dist/bin/tps.js) under this test's
    // runtime, Bun.
    const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
    delete env.TPS_BRANCH_DAEMON;
    child = spawn(process.execPath, [TPS_BIN, "branch", "start", QUIET_NONO_CHECK_FLAG], { env, stdio: ["ignore", "ignore", "pipe"] });

    channel = await connectHost(port, host, branch);
    expect(channel.isAlive()).toBe(true);

    // The daemon is connected with a working log and state path; break both
    // now. A regular file in the connections directory's place and a directory
    // in the log file's place fail for every uid, including root in CI.
    const connections = join(process.env.TPS_ROOT!, "connections");
    rmSync(connections, { recursive: true, force: true });
    writeFileSync(connections, "not a directory");
    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    rmSync(logPath, { force: true });
    mkdirSync(logPath);

    // Close the read end of the child's stderr pipe. Logging writes nothing to
    // stderr, so this is a regression pin: the child must stay alive and keep
    // echoing.
    child.stderr!.destroy();

    const first = await exchange(channel, { type: MSG_HEARTBEAT, seq: 30, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
    expect(first.seq).toBe(30);
    const second = await exchange(channel, { type: MSG_HEARTBEAT, seq: 31, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
    expect(second.seq).toBe(31);

    // Give the child a moment before asserting it is still running.
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  }, 30_000);

  test("heartbeat echoes continue when the state and log paths fail after connect and the stderr pipe is never read", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    writeFileSync(
      join(process.env.TPS_IDENTITY_DIR!, "host.json"),
      JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
    );
    const port = await freePort();
    writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");

    const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
    delete env.TPS_BRANCH_DAEMON;
    child = spawn(process.execPath, [TPS_BIN, "branch", "start", QUIET_NONO_CHECK_FLAG], { env, stdio: ["ignore", "ignore", "pipe"] });
    // Leave the read end open and never drain it: a stderr write from log
    // handling would fill the pipe and stall a blocking writer.
    child.stderr!.pause();

    channel = await connectHost(port, host, branch);
    expect(channel.isAlive()).toBe(true);

    // Break the state and log paths after connect. A regular file in the
    // connections directory's place and a directory in the log file's place
    // fail for every uid, including root in CI.
    const connections = join(process.env.TPS_ROOT!, "connections");
    rmSync(connections, { recursive: true, force: true });
    writeFileSync(connections, "not a directory");
    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    rmSync(logPath, { force: true });
    mkdirSync(logPath);

    // Each heartbeat attempts two log appends. The pipe stays open but is
    // never drained, so a blocking stderr fallback would eventually stall the
    // daemon; log handling writes nothing to stderr.
    for (let i = 0; i < 400; i++) {
      const seq = 100 + i;
      const echo = await exchange(channel, { type: MSG_HEARTBEAT, seq, ts: new Date().toISOString(), body: {} }, MSG_HEARTBEAT);
      expect(echo.seq).toBe(seq);
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  }, 60_000);

  test("a newline in a log message is escaped onto one appended line", async () => {
    mkdirSync(process.env.TPS_ROOT!, { recursive: true });
    const logPath = join(process.env.TPS_ROOT!, "branch.log");
    const script = join(root, "log-line.ts");
    writeFileSync(
      script,
      `import { logLine } from ${JSON.stringify(resolve(import.meta.dir, "../src/commands/branch.ts"))};\n` +
        `logLine("PROXY", "Service 'agent\\nname\\u0085nel\\u2028ls\\u2029ps' proxied");\n`,
    );

    child = spawn(process.execPath, [script], { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] });
    const code = await new Promise<number | null>((resolveExit) => child!.once("exit", resolveExit));

    expect(code).toBe(0);
    const entries = readFileSync(logPath, "utf-8").split("\n").filter((line) => line.length > 0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Service 'agent\\nname\\u0085nel\\u2028ls\\u2029ps' proxied");
  }, 30_000);
});
