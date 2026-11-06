/**
 * cli#730 — the branch pid record is claimed and removed only while the
 * branch pid lock is held, including by `tps office kill`. These tests drive
 * the real CLI and real daemons under a temp HOME; the pause seam is enabled
 * by TPS_BRANCH_TEST_PAUSE_DIR inside the isolated test root (TPS_TEST_ROOT).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
import { hostStatePath, writeHostState } from "../src/utils/connection-state.js";
import { branchPidLockRoot, withBranchPidLock, writeBranchConf } from "../src/commands/branch.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";
import { readPidFile, serializePidRecord } from "../src/utils/pid-file.js";
import { probeStdoutUnderRoot, type IdentityVerdict } from "./helpers/branch-daemon-identity.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 20_000;
const EXIT_MS = 30_000;

let root: string;
let pidFile: string;
let logFile: string;
let pauseDir: string;
let savedEnv: Record<string, string | undefined>;
const daemons: { pid: number; startToken: string }[] = [];
const unverifiedIdentityPids = new Set<number>();
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const net = await import("node:net");
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

function prepareBranch(port: number): void {
  const branch = generateKeyPair();
  const host = generateKeyPair();
  saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
  writeFileSync(
    join(process.env.TPS_IDENTITY_DIR!, "host.json"),
    JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
  );
  writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");
}

function startToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

function pauseEnv(phase: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TPS_BRANCH_TEST_PAUSE_DIR: pauseDir,
    TPS_BRANCH_TEST_PAUSE_PHASE: phase,
  };
}

function launcherEnv(phase: string): NodeJS.ProcessEnv {
  const env = pauseEnv(phase);
  delete env.NODE_ENV;
  delete env.TPS_BRANCH_DAEMON;
  delete env.TPS_BRANCH_NO_DAEMON;
  return env;
}

/** All pause phases, no launcher/daemon overrides. */
function allPhasesEnv(): NodeJS.ProcessEnv {
  const env = launcherEnv("unused");
  delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
  return env;
}

/** No pause and no launcher/daemon overrides. */
function plainEnv(): NodeJS.ProcessEnv {
  const env = launcherEnv("unused");
  delete env.TPS_BRANCH_TEST_PAUSE_DIR;
  delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
  return env;
}

async function waitFor<T>(read: () => T | null, what: string, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function waitForReady(phase: string, daemonPid?: number): Promise<string> {
  try {
    return await waitFor(
      () => {
        const name = readdirSync(pauseDir).find((entry) => entry.startsWith(`ready-${phase}-`));
        return name === undefined ? null : join(pauseDir, name);
      },
      `pause ${phase}`,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${daemonState(daemonPid)}`);
  }
}

/** The daemon's last recorded output and process state, for a failed wait. */
function daemonState(pid: number | undefined): string {
  const parts: string[] = [pid === undefined ? "daemon pid unknown" : `daemon pid ${pid}: ${pidState(pid)}`];
  try {
    const lines = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-10);
    parts.push(`branch.log: ${lines.length === 0 ? "(empty)" : lines.join(" | ")}`);
  } catch (error) {
    parts.push(`branch.log: unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(pauseDir);
  } catch {}
  parts.push(`pause dir: ${entries.length === 0 ? "(empty)" : entries.join(", ")}`);
  return parts.join("; ");
}

function release(phase: string): void {
  writeFileSync(join(pauseDir, `go-${phase}`), "", "utf-8");
}

async function waitForExit(child: ChildProcess, timeoutMs = EXIT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  // Resolve on "close", not "exit": "close" fires only after the child's piped
  // stdout and stderr have drained, so the captured output is complete when
  // the caller inspects it.
  const drained = (stream: NodeJS.ReadableStream | null): boolean =>
    stream === null || (stream as { readableEnded?: boolean }).readableEnded === true ||
    (stream as { destroyed?: boolean }).destroyed === true;
  if ((child.exitCode !== null || child.signalCode !== null) && drained(child.stdout) && drained(child.stderr)) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit within the bound")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForLogStarted(): Promise<void> {
  await waitFor(
    () => {
      try {
        return readFileSync(logFile, "utf8").includes("STARTED") ? true : null;
      } catch {
        return null;
      }
    },
    "daemon STARTED log line",
  );
}

async function waitForListening(port: number): Promise<void> {
  const net = await import("node:net");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const connected = await new Promise<boolean>((resolveConnect) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolveConnect(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error(`daemon did not listen on 127.0.0.1:${port}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function waitForNotListening(port: number): Promise<void> {
  const net = await import("node:net");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const connected = await new Promise<boolean>((resolveConnect) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolveConnect(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (!connected) return;
    if (Date.now() >= deadline) throw new Error(`daemon still listens on 127.0.0.1:${port}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function stoppedCount(): number {
  try {
    return (readFileSync(logFile, "utf8").match(/STOPPED:/g) ?? []).length;
  } catch {
    return 0;
  }
}

async function waitForRunningRecord(): Promise<{ pid: number; startToken: string }> {
  return waitFor(
    () => {
      const state = readPidFile(pidFile);
      return state.kind === "running" ? { pid: state.pid, startToken: state.startToken } : null;
    },
    "a running pid record",
  );
}

/** True when the pid is gone or a zombie; a container's PID 1 may not reap. */
function pidExited(pid: number): boolean {
  if (pidState(pid) === "gone") return true;
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0] === "Z";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function waitForPidGone(pid: number): Promise<void> {
  await waitFor(() => (pidExited(pid) ? true : null), `pid ${pid} to exit`);
}

function spawnDaemon(phase: string): ChildProcess {
  const env = pauseEnv(phase);
  env.TPS_BRANCH_NO_DAEMON = "1";
  delete env.TPS_BRANCH_DAEMON;
  const child = spawn("node", [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  return child;
}

function reapedPid(): number {
  const child = spawnSync("true", []);
  if (child.pid === undefined) throw new Error("could not spawn a helper process");
  if (pidState(child.pid) !== "gone") throw new Error("helper pid was reused; rerun the test");
  return child.pid;
}

/** A parseable record whose ignored field carries `byte` (invalid UTF-8 alone). */
function recordWithIgnoredByte(pid: number, token: string | null, byte: number): Buffer {
  const tokenJson = token === null ? "null" : JSON.stringify(token);
  return Buffer.concat([
    Buffer.from(`{"pid":${pid},"startToken":${tokenJson},"note":"`, "utf-8"),
    Buffer.from([byte]),
    Buffer.from('"}\n', "utf-8"),
  ]);
}

/** Replace the pid record with a symlink to `target`. */
function replaceWithSymlink(target: string): void {
  rmSync(pidFile, { force: true });
  symlinkSync(target, pidFile);
}

interface PausedStop {
  daemon: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
}

/** Start a daemon, record it, run `branch stop` and wait until the daemon is
 *  paused in shutdown (stop is then in its unlocked post-signal wait). */
async function stopWhileDaemonPausesInShutdown(
  record: (pid: number, token: string) => string | Buffer = (pid, token) => serializePidRecord(pid, token),
): Promise<PausedStop> {
  const port = await freePort();
  prepareBranch(port);
  const daemon = spawnDaemon("shutdown-before-unlink");
  await waitForLogStarted();
  await waitForListening(port);
  writeFileSync(pidFile, record(daemon.pid!, startToken(daemon.pid!)));
  expect(readPidFile(pidFile).kind).toBe("running");

  const stop = spawn("node", [TPS_BIN, "branch", "stop"], {
    env: plainEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(stop);
  let stdout = "";
  let stderr = "";
  stop.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  stop.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = waitForExit(stop);
  await waitForReady("shutdown-before-unlink", daemon.pid);
  return { daemon, exited, stdout: () => stdout, stderr: () => stderr };
}


/** A live process a host state record can name; office kill signals it. */
function spawnLiveHost(): number {
  const child = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  if (child.pid === undefined) throw new Error("could not spawn host process");
  return child.pid;
}

/** Write a verified host state record for `pid` and return its path. */
function writeHostRecord(branch: string, pid: number): string {
  writeHostState({
    branch,
    connectedAt: "",
    lastHeartbeatSent: "",
    lastHeartbeatAck: null,
    reconnectCount: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    pid,
    startToken: startToken(pid),
  });
  return hostStatePath(branch);
}

interface PausedOfficeKill {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
}

/** Run `office kill` against a stale record and replace that record with a
 *  symlink during the unlocked interval before removal. */
async function replaceBranchRecordDuringOfficeKill(target: string | null): Promise<PausedOfficeKill> {
  prepareBranch(await freePort());
  const stale = reapedPid();
  writeFileSync(pidFile, serializePidRecord(stale, null));

  const kill = spawn("node", [TPS_BIN, "office", "kill"], {
    env: allPhasesEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(kill);
  let stderr = "";
  kill.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = waitForExit(kill);

  await waitForReady("office-kill-branch-before-decision");
  release("office-kill-branch-before-decision");

  await waitForReady("office-kill-branch-before-unlink");
  const waitProbe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
  if (waitProbe !== null) waitProbe.release();
  expect(waitProbe).not.toBeNull();

  const linkTarget = target ?? join(root, "missing-target");
  if (target !== null) writeFileSync(target, "not a pid record\n");
  replaceWithSymlink(linkTarget);
  release("office-kill-branch-before-unlink");

  await waitForReady("office-kill-branch-before-removal");
  release("office-kill-branch-before-removal");

  return { exited, stderr: () => stderr };
}

/** Pid record files under the test root, including the branch record. */
function recordFilesUnder(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...recordFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".pid")) files.push(full);
  }
  return files;
}

function runsTestDaemon(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readProcessFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): IdentityVerdict {
  let command: string;
  let environ: string | null = null;
  try {
    if (platform === "linux") {
      command = readProcessFile(`/proc/${pid}/cmdline`).replaceAll("\0", " ");
      environ = readProcessFile(`/proc/${pid}/environ`);
    } else {
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (ps.status !== 0 || typeof ps.stdout !== "string") return "unverified";
      command = ps.stdout;
    }
  } catch {
    return "other";
  }
  if (platform !== "linux") {
    if (command.trim() !== "tps" && !command.includes(TPS_BIN)) return "other";
    return probeStdoutUnderRoot(pid, root);
  }
  if (command.trim() !== "tps" && (!command.includes(TPS_BIN) || !command.includes("branch"))) return "other";
  const entries = environ!.split("\0");
  return entries.includes(`HOME=${root}`) && entries.includes("TPS_BRANCH_DAEMON=1") ? "this-daemon" : "other";
}

function leakDiagnostic(pids: number[]): string {
  return pids
    .map((pid) => unverifiedIdentityPids.has(pid) ? `identity could not be verified for pid ${pid}` : `pid ${pid} is still alive`)
    .join("; ");
}

/** SIGKILL each registered daemon still running whose start token matches the
 *  one recorded at registration. A pid whose token changed is left alone and
 *  reported. */
async function stopRegisteredDaemons(
  records: { pid: number; startToken: string }[],
  readToken: (pid: number) => string | null = processStartToken,
): Promise<void> {
  const failures: string[] = [];
  for (const record of records) {
    if (pidExited(record.pid)) continue;
    if (readToken(record.pid) !== record.startToken) {
      unverifiedIdentityPids.add(record.pid);
      failures.push(`identity could not be verified for pid ${record.pid}; not signalled`);
      continue;
    }
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForPidGone(record.pid).catch(() => {});
  }
  if (failures.length > 0) throw new Error(`registered-daemon cleanup failed: ${failures.join("; ")}`);
}

async function stopRecordedDaemons(
  identity: (pid: number) => IdentityVerdict = runsTestDaemon,
  readToken: (pid: number) => string | null = processStartToken,
): Promise<void> {
  const failures: string[] = [];
  for (const path of new Set([pidFile, ...recordFilesUnder(root)])) {
    const state = readPidFile(path);
    if (state.kind !== "running") continue;
    const verdict = identity(state.pid);
    if (verdict === "unverified") {
      unverifiedIdentityPids.add(state.pid);
      failures.push(`identity could not be verified for pid ${state.pid}; not signalled`);
      continue;
    }
    if (verdict !== "this-daemon") continue;
    if (readToken(state.pid) !== state.startToken) {
      unverifiedIdentityPids.add(state.pid);
      failures.push(`identity could not be verified for pid ${state.pid}; not signalled`);
      continue;
    }
    try {
      process.kill(state.pid, "SIGKILL");
    } catch (error) {
      if (pidState(state.pid) !== "gone") {
        failures.push(`could not kill pid ${state.pid}: ${(error as Error).message}`);
      }
    }
    try {
      await waitForPidGone(state.pid);
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  if (failures.length > 0) throw new Error(`recorded-daemon cleanup failed: ${failures.join("; ")}`);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of [
    "HOME",
    "TPS_ROOT",
    "TPS_IDENTITY_DIR",
    "TPS_REGISTRY_DIR",
    "TPS_AGENT_ID",
    "TPS_VAULT_KEY",
    "TPS_BRANCH_TEST_PAUSE_DIR",
    "TPS_BRANCH_TEST_PAUSE_PHASE",
  ]) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), "tps-branch-730-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
  process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  process.env.TPS_AGENT_ID = "agent-a";
  process.env.TPS_VAULT_KEY = "branch-730-test";
  pidFile = join(root, ".tps", "branch.pid");
  logFile = join(root, ".tps", "branch.log");
  pauseDir = mkdtempSync(join(root, "pause-"));
  mkdirSync(join(root, ".tps"), { recursive: true });
});

afterEach(async () => {
  const cleanupFailures: string[] = [];
  try {
    await stopRegisteredDaemons(daemons.splice(0));
  } catch (error) {
    cleanupFailures.push((error as Error).message);
  }
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    await stopRecordedDaemons();
  } catch (error) {
    cleanupFailures.push((error as Error).message);
  }
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  } finally {
    if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("; "));
  }
});

describe("branch pid record ownership (cli#730)", () => {
  test("two launchers started together spawn exactly one daemon and leave one record", async () => {
    const port = await freePort();
    prepareBranch(port);
    const phase = "launch-before-spawn";

    const launchers = [0, 1].map(() => {
      const child = spawn("node", [TPS_BIN, "branch", "start"], {
        env: launcherEnv(phase),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return { child, stdout: () => stdout, stderr: () => stderr };
    });

    await waitForReady(phase);
    const probe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (probe !== null) probe.release();
    expect(probe).toBeNull();
    release(phase);
    const exits = await Promise.all(launchers.map(({ child }) => waitForExit(child)));

    const announced = launchers.flatMap(({ stdout }) =>
      [...stdout().matchAll(/Branch daemon spawned \(pid (\d+)\)/g)].map((match) => Number(match[1])),
    );
    // Register before any assertion. afterEach also stops each running daemon
    // named by a verified record in this test root, so cleanup does not depend
    // on this announcement to find one.
    daemons.push(...announced.map((pid) => ({ pid, startToken: startToken(pid) })));
    expect(announced.length).toBe(1);

    const refused = exits.filter((exit) => exit.code !== 0);
    expect(refused.length).toBe(1);
    expect(launchers.map(({ stderr }) => stderr()).join("\n")).toContain("refusing to spawn");

    const running = await waitForRunningRecord();
    daemons.push(running);
    expect(running.pid).toBe(announced[0]!);
    expect(pidState(running.pid)).toBe("alive");
    expect(readPidFile(pidFile).kind).toBe("running");

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 40_000);

  test("a SIGTERM before the listener opens runs shutdown with no server", async () => {
    const port = await freePort();
    prepareBranch(port);
    const phase = "startup-before-listener";
    const daemon = spawnDaemon(phase);
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
    await waitForReady(phase, daemon.pid);
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stoppedCount()).toBe(1);
    expect(readPidFile(pidFile).kind).toBe("missing");
    expect(pidExited(daemon.pid!)).toBe(true);
    await waitForNotListening(port);
  }, 40_000);

  test("a SIGTERM while the listener is open and before the outbox watcher runs shutdown", async () => {
    const port = await freePort();
    prepareBranch(port);
    const phase = "listening-before-steady-state";
    const daemon = spawnDaemon(phase);
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
    await waitForReady(phase, daemon.pid);
    await waitForListening(port);
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stoppedCount()).toBe(1);
    expect(readPidFile(pidFile).kind).toBe("missing");
    expect(pidExited(daemon.pid!)).toBe(true);
    await waitForNotListening(port);
  }, 40_000);

  test("a second signal during shutdown does not run the shutdown path twice", async () => {
    const port = await freePort();
    prepareBranch(port);
    const phase = "shutdown-after-signal";
    const daemon = spawnDaemon(phase);
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
    await waitForLogStarted();
    await waitForListening(port);
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");
    await waitForReady(phase, daemon.pid);
    daemon.kill("SIGINT");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(stoppedCount()).toBe(1);

    release(phase);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stoppedCount()).toBe(1);
    expect(readFileSync(logFile, "utf8")).not.toContain("No pid record at");
    expect(readPidFile(pidFile).kind).toBe("missing");
    expect(pidExited(daemon.pid!)).toBe(true);
  }, 40_000);

  test("a pause dir inherited without the isolated test root is ignored", async () => {
    const port = await freePort();
    prepareBranch(port);
    const env = launcherEnv("unused");
    delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
    delete env.TPS_TEST_ROOT;
    delete env.TPS_TEST_ROOT_TOKEN;

    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(launcher);
    let stdout = "";
    launcher.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("Branch daemon spawned");
    const running = await waitForRunningRecord();
    daemons.push(running);
    await waitForLogStarted();
    expect(pidState(running.pid)).toBe("alive");
    expect(readdirSync(pauseDir)).toEqual([]);

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 40_000);

  test("a hand-set TPS_TEST_ROOT without a valid marker token ignores the pause", async () => {
    const port = await freePort();
    prepareBranch(port);
    const env = launcherEnv("unused");
    delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
    env.TPS_TEST_ROOT = root;
    env.TPS_TEST_ROOT_TOKEN = "hand-set-token";

    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(launcher);
    let stdout = "";
    launcher.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("Branch daemon spawned");
    const running = await waitForRunningRecord();
    daemons.push(running);
    await waitForLogStarted();
    expect(pidState(running.pid)).toBe("alive");
    expect(readdirSync(pauseDir)).toEqual([]);

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 40_000);

  test("a registered daemon whose start token changed is reported and not signalled", async () => {
    const port = await freePort();
    prepareBranch(port);
    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env: plainEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(launcher);
    const running = await waitForRunningRecord();
    daemons.push(running);
    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    await waitForLogStarted();

    let message = "";
    try {
      await stopRegisteredDaemons([running], () => "recycled-token");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`identity could not be verified for pid ${running.pid}; not signalled`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(pidState(running.pid)).toBe("alive");
    expect(processStartToken(running.pid)).toBe(running.startToken);
    expect(leakDiagnostic([running.pid])).toBe(`identity could not be verified for pid ${running.pid}`);
  }, 40_000);

  test("stopRecordedDaemons reports a daemon whose identity probe cannot answer and leaves it running", async () => {
    const port = await freePort();
    prepareBranch(port);
    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env: plainEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(launcher);
    const running = await waitForRunningRecord();
    daemons.push(running);
    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    await waitForLogStarted();

    let message = "";
    try {
      await stopRecordedDaemons(() => "unverified");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`identity could not be verified for pid ${running.pid}; not signalled`);
    expect(pidState(running.pid)).toBe("alive");
    expect(leakDiagnostic([running.pid])).toBe(`identity could not be verified for pid ${running.pid}`);
  }, 40_000);

  test("shutdown holds the record lock and preserves a replacement visible at its final read", async () => {
    const port = await freePort();
    prepareBranch(port);
    const phase = "shutdown-before-unlink";
    const daemon = spawnDaemon(phase);
    await waitForLogStarted();
    await waitForListening(port);
    expect(daemon.pid).toBeDefined();
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    // The daemon installs its shutdown handlers before it opens the listener,
    // so a SIGTERM sent now reaches its shutdown path (cli#744).
    daemon.kill("SIGTERM");
    await waitForReady(phase, daemon.pid);

    const probe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (probe !== null) probe.release();
    expect(probe).toBeNull();

    const newer = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(newer);
    expect(newer.pid).toBeDefined();
    const replacement = serializePidRecord(newer.pid!, startToken(newer.pid!));
    writeFileSync(pidFile, replacement);
    release(phase);

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    const state = readPidFile(pidFile);
    expect(state.kind).toBe("running");
    if (state.kind === "running") expect(state.pid).toBe(newer.pid);
    expect(readFileSync(logFile, "utf8")).toContain(`Pid file ${pidFile} changed (replaced or removed); this command removed nothing.`);
  }, 40_000);

  test("runStop's final locked read preserves a readable replacement and exits non-zero", async () => {
    prepareBranch(await freePort());
    const stale = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stale, null));
    const phase = "stop-before-unlink";

    const stop = spawn("node", [TPS_BIN, "branch", "stop"], {
      env: pauseEnv(phase),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(stop);
    let stderr = "";
    stop.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = waitForExit(stop);
    await waitForReady(phase);

    const probe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (probe !== null) probe.release();
    expect(probe).toBeNull();

    const newer = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(newer);
    expect(newer.pid).toBeDefined();
    const replacement = serializePidRecord(newer.pid!, startToken(newer.pid!));
    writeFileSync(pidFile, replacement);
    release(phase);

    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain(`Branch pid file ${pidFile} changed (replaced or removed); this command removed nothing.`);
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    const state = readPidFile(pidFile);
    expect(state.kind).toBe("running");
    if (state.kind === "running") expect(state.pid).toBe(newer.pid);
    expect(pidState(newer.pid!)).toBe("alive");
  }, 40_000);

  test("runStop's unlocked post-signal wait preserves a readable replacement and exits non-zero", async () => {
    const { daemon, exited, stderr } = await stopWhileDaemonPausesInShutdown();
    const newer = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(newer);
    expect(newer.pid).toBeDefined();
    const replacement = serializePidRecord(newer.pid!, startToken(newer.pid!));
    writeFileSync(pidFile, replacement);
    release("shutdown-before-unlink");

    expect(await waitForExit(daemon)).toEqual({ code: 0, signal: null });
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} changed (replaced or removed); this command removed nothing.`);
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    expect(readPidFile(pidFile).kind).toBe("running");
    expect(pidState(newer.pid!)).toBe("alive");
  }, 40_000);

  test("runStop's post-signal wait compares raw bytes and preserves a byte-only replacement", async () => {
    const { daemon, exited, stderr } = await stopWhileDaemonPausesInShutdown((pid, token) =>
      recordWithIgnoredByte(pid, token, 0x80),
    );
    const replacement = recordWithIgnoredByte(daemon.pid!, startToken(daemon.pid!), 0x81);
    writeFileSync(pidFile, replacement);
    release("shutdown-before-unlink");

    expect(await waitForExit(daemon)).toEqual({ code: 0, signal: null });
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} changed (replaced or removed); this command removed nothing.`);
    expect(readFileSync(pidFile).equals(replacement)).toBe(true);
  }, 40_000);

  test("runStop's unlocked post-signal wait keeps a symlink to a readable file and exits non-zero", async () => {
    const { daemon, exited, stderr } = await stopWhileDaemonPausesInShutdown();
    const target = join(root, "decoy.txt");
    writeFileSync(target, "not a pid record\n");
    replaceWithSymlink(target);
    release("shutdown-before-unlink");

    expect(await waitForExit(daemon)).toEqual({ code: 0, signal: null });
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} could not be read at the final check`);
    expect(stderr()).toContain("Inspect it and remove it yourself if the branch daemon is not running");
    expect(readlinkSync(pidFile)).toBe(target);
  }, 40_000);

  test("runStop's unlocked post-signal wait keeps a dangling symlink and exits non-zero", async () => {
    const { daemon, exited, stderr } = await stopWhileDaemonPausesInShutdown();
    const target = join(root, "missing-target");
    replaceWithSymlink(target);
    release("shutdown-before-unlink");

    expect(await waitForExit(daemon)).toEqual({ code: 0, signal: null });
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} could not be read at the final check`);
    expect(stderr()).toContain("Inspect it and remove it yourself if the branch daemon is not running");
    expect(readlinkSync(pidFile)).toBe(target);
  }, 40_000);

  test("runStop's unlocked post-signal wait reports an already-gone record and exits zero", async () => {
    const { daemon, exited, stdout } = await stopWhileDaemonPausesInShutdown();
    rmSync(pidFile, { force: true });
    release("shutdown-before-unlink");

    expect(await waitForExit(daemon)).toEqual({ code: 0, signal: null });
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout()).toContain("PID file already gone");
    expect(readPidFile(pidFile).kind).toBe("missing");
  }, 40_000);

  test("office kill preserves a launcher's replacement of a stale record it decided on", async () => {
    const port = await freePort();
    prepareBranch(port);
    const stale = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stale, null));

    const kill = spawn("node", [TPS_BIN, "office", "kill"], {
      env: allPhasesEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(kill);
    let stderr = "";
    kill.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = waitForExit(kill);

    await waitForReady("office-kill-branch-before-decision");
    const decisionProbe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (decisionProbe !== null) decisionProbe.release();
    expect(decisionProbe).toBeNull();
    release("office-kill-branch-before-decision");

    await waitForReady("office-kill-branch-before-unlink");
    const waitProbe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (waitProbe !== null) waitProbe.release();
    expect(waitProbe).not.toBeNull();

    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env: plainEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(launcher);
    const launched = await waitForRunningRecord();
    daemons.push(launched);
    const replacement = readFileSync(pidFile, "utf8");
    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    release("office-kill-branch-before-unlink");

    await waitForReady("office-kill-branch-before-removal");
    const removalProbe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (removalProbe !== null) removalProbe.release();
    expect(removalProbe).toBeNull();
    release("office-kill-branch-before-removal");

    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain(`Branch pid file ${pidFile} was replaced; the branch pid file was not removed.`);
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    const state = readPidFile(pidFile);
    expect(state.kind).toBe("running");
    if (state.kind === "running") expect(state.pid).toBe(launched.pid);
    expect(pidState(launched.pid)).toBe("alive");
  }, 40_000);

  test("office kill reports a handled host record before a stale branch record, in order", async () => {
    prepareBranch(await freePort());
    const hostPid = spawnLiveHost();
    const hostPath = writeHostRecord("host-a", hostPid);
    const stale = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stale, null));

    // Run office kill asynchronously: it waits for the host it signals, and
    // that host is this test process's child. Keeping the event loop free lets
    // Node reap the child; spawnSync blocks it, leaving a zombie that still
    // answers kill -0 on platforms without a zombie-state read.
    const kill = spawn("node", [TPS_BIN, "office", "kill", "--quiet-nono-check"], {
      env: plainEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(kill);
    let stdout = "";
    let stderr = "";
    kill.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    kill.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = await waitForExit(kill);

    expect(exit.code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.split(/\r?\n/).filter((line) => line !== "")).toEqual([
      `Host state record (pid ${hostPid}) stopped; record removed: ${hostPath}.`,
      `Stale branch pid file removed: ${pidFile}; branch-record handling signalled no process.`,
      "Kill switch engaged. Terminated 1 TPS process(es).",
    ]);
    expect(existsSync(hostPath)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 40_000);

  test("office kill reports a handled host record before a replaced branch record, in order", async () => {
    prepareBranch(await freePort());
    const hostPid = spawnLiveHost();
    const hostPath = writeHostRecord("host-a", hostPid);
    const stale = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stale, null));

    const kill = spawn("node", [TPS_BIN, "office", "kill", "--quiet-nono-check"], {
      env: allPhasesEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(kill);
    let stdout = "";
    let stderr = "";
    kill.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    kill.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = waitForExit(kill);

    await waitForReady("office-kill-branch-before-decision");
    release("office-kill-branch-before-decision");

    await waitForReady("office-kill-branch-before-unlink");
    const replacement = serializePidRecord(process.pid, startToken(process.pid));
    writeFileSync(pidFile, replacement);
    release("office-kill-branch-before-unlink");

    await waitForReady("office-kill-branch-before-removal");
    release("office-kill-branch-before-removal");

    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stdout.split(/\r?\n/).filter((line) => line !== "")).toEqual([
      `Host state record (pid ${hostPid}) stopped; record removed: ${hostPath}.`,
    ]);
    expect(stderr.split(/\r?\n/).filter((line) => line !== "")).toEqual([
      `Branch pid file ${pidFile} was replaced; the branch pid file was not removed.`,
      `Branch pid file ${pidFile} was replaced; the branch pid file was not removed.`,
    ]);
    expect(existsSync(hostPath)).toBe(false);
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
  }, 40_000);

  test("office kill's final read compares raw bytes and preserves a byte-only replacement", async () => {
    prepareBranch(await freePort());
    const stale = reapedPid();
    writeFileSync(pidFile, recordWithIgnoredByte(stale, null, 0x80));

    const kill = spawn("node", [TPS_BIN, "office", "kill"], {
      env: allPhasesEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(kill);
    let stderr = "";
    kill.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = waitForExit(kill);

    await waitForReady("office-kill-branch-before-decision");
    release("office-kill-branch-before-decision");

    await waitForReady("office-kill-branch-before-unlink");
    const waitProbe = acquireMailLockSync(branchPidLockRoot(pidFile), { timeoutMs: 0 });
    if (waitProbe !== null) waitProbe.release();
    expect(waitProbe).not.toBeNull();

    const replacement = recordWithIgnoredByte(stale, null, 0x81);
    writeFileSync(pidFile, replacement);
    release("office-kill-branch-before-unlink");

    await waitForReady("office-kill-branch-before-removal");
    release("office-kill-branch-before-removal");

    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain(`Branch pid file ${pidFile} was replaced; the branch pid file was not removed.`);
    expect(readFileSync(pidFile).equals(replacement)).toBe(true);
  }, 40_000);

  test("office kill keeps a symlink to a readable file at its final read and exits non-zero", async () => {
    const target = join(root, "decoy.txt");
    const { exited, stderr } = await replaceBranchRecordDuringOfficeKill(target);
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} could not be read at the final check`);
    expect(stderr()).toContain("Inspect it and remove it yourself if the branch daemon is not running");
    expect(readlinkSync(pidFile)).toBe(target);
  }, 40_000);

  test("office kill keeps a dangling symlink at its final read and exits non-zero", async () => {
    const target = join(root, "missing-target");
    const { exited, stderr } = await replaceBranchRecordDuringOfficeKill(null);
    const exit = await exited;
    expect(exit.code).not.toBe(0);
    expect(stderr()).toContain(`Branch pid file ${pidFile} could not be read at the final check`);
    expect(stderr()).toContain("Inspect it and remove it yourself if the branch daemon is not running");
    expect(readlinkSync(pidFile)).toBe(target);
  }, 40_000);

  test("office kill reports a branch lock timeout alongside a host-record failure and exits non-zero", () => {
    const connectionsDir = join(root, ".tps", "connections");
    const hostPath = join(connectionsDir, "host-a.json");
    mkdirSync(connectionsDir, { recursive: true });
    writeFileSync(hostPath, '{"pid":"not-a-number"}\n');
    const lockRoot = branchPidLockRoot(pidFile);
    mkdirSync(join(lockRoot, ".mail-lock.claim"), { recursive: true });

    const result = spawnSync("node", [TPS_BIN, "office", "kill"], {
      encoding: "utf8",
      timeout: 20_000,
      env: plainEnv(),
    });

    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(hostPath);
    expect(output).toContain("could not be parsed");
    expect(output).toContain(`Branch pid record lock ${join(lockRoot, ".mail-lock")} could not be acquired`);
    expect(readFileSync(hostPath, "utf8")).toBe('{"pid":"not-a-number"}\n');
  }, 40_000);

  test("a claim-directory-only lock times out with the lock-or-claim message and the remedy succeeds", () => {
    const lockRoot = branchPidLockRoot(pidFile);
    mkdirSync(join(lockRoot, ".mail-lock.claim"), { recursive: true });
    let message = "";
    try {
      withBranchPidLock(pidFile, "test the lock", () => "held");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("The lock or its reclamation claim is held, or its owner could not be verified.");
    expect(message).toContain(`remove ${lockRoot} and retry`);
    expect(message).not.toContain("Its owner is a live process");

    rmSync(lockRoot, { recursive: true, force: true });
    expect(withBranchPidLock(pidFile, "test the lock", () => "held")).toBe("held");
  }, 20_000);

  let unannouncedDaemon: { pid: number; startToken: string } | undefined;

  test("afterEach stops a launcher's daemon when its announcement is not read", async () => {
    prepareBranch(await freePort());
    // The launcher's stdout is discarded, so no announcement is parsed and the
    // daemon is never registered in `daemons`. Only the pid record names it.
    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env: plainEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(launcher);
    const running = await waitForRunningRecord();
    unannouncedDaemon = running;
    await waitForLogStarted();
    expect(await waitForExit(launcher)).toEqual({ code: 0, signal: null });
    expect(pidState(running.pid)).toBe("alive");
  }, 40_000);

  afterAll(() => {
    if (unannouncedDaemon === undefined) throw new Error("the launcher recorded no daemon");
    const leaked = pidExited(unannouncedDaemon.pid) ? [] : [unannouncedDaemon.pid];
    expect(leaked, leakDiagnostic(leaked)).toEqual([]);
  });
});

describe("Linux daemon cleanup identity", () => {
  test("matches the daemon before and after meow sets its title", () => {
    const parsed = spawnSync("node", ["--input-type=module", "-e", `
      import meow from "meow";
      import { readFileSync } from "node:fs";
      const command = () => process.platform === "linux" ? readFileSync("/proc/self/cmdline", "utf8") : null;
      const beforeCommand = command();
      const before = process.title;
      meow("", { importMeta: { url: ${JSON.stringify(new URL("../bin/tps.ts", import.meta.url).href)} }, argv: ["branch", "start"] });
      console.log(JSON.stringify({ before, after: process.title, commands: beforeCommand === null ? null : [beforeCommand, command()] }));
    `, TPS_BIN, "branch", "start"], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
    const titles = JSON.parse(parsed.stdout);
    expect({ before: titles.before, after: titles.after }).toEqual({ before: "node", after: "tps" });
    const commands: string[] = titles.commands ?? [`node\0${TPS_BIN}\0branch\0start\0`, `${titles.after}\0\0`];
    for (const command of commands) {
      const identity = (home: string, daemon: string) => runsTestDaemon(123, "linux", (path) =>
        path.endsWith("/cmdline") ? command : `HOME=${home}\0${daemon}\0`);
      expect(identity(root, "TPS_BRANCH_DAEMON=1")).toBe("this-daemon");
      expect(identity(`${root}-other`, "TPS_BRANCH_DAEMON=1")).toBe("other");
      expect(identity(root, "TPS_BRANCH_DAEMON=0")).toBe("other");
      expect(identity(root, "")).toBe("other");
    }
  });
});
