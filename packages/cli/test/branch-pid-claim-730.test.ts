/**
 * cli#730 — the branch pid record is claimed and removed only while the
 * branch pid lock is held, including by `tps office kill`. These tests drive
 * the real CLI and real daemons under a temp HOME; the pause seam is enabled
 * by TPS_BRANCH_TEST_PAUSE_DIR inside the isolated test root (TPS_TEST_ROOT).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { hostStatePath, writeHostState } from "../src/utils/connection-state.js";
import { branchPidLockRoot, withBranchPidLock, writeBranchConf } from "../src/commands/branch.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";
import { readPidFile, serializePidRecord } from "../src/utils/pid-file.js";
import { probeStdoutUnderRoot, type IdentityVerdict } from "./helpers/branch-daemon-identity.js";
import { bindErrorIn, holdPort, PORT_ATTEMPTS, withPortRetry } from "./helpers/port.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 20_000;
const EXIT_MS = 30_000;
const STDERR_TAIL_BYTES = 4 * 1024;
/** How long a gone daemon's "close" may lag its pid disappearing. */
const EXIT_REPORT_MS = 2_000;

let root: string;
let pidFile: string;
let logFile: string;
let pauseDir: string;
let savedEnv: Record<string, string | undefined>;
const daemons: { pid: number; startToken: string }[] = [];
const unverifiedIdentityPids = new Set<number>();
const children: ChildProcess[] = [];

interface DaemonExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** One child's exit status and the last STDERR_TAIL_BYTES of its stderr. */
interface DaemonExitState {
  status: DaemonExit | null;
  stderr: Buffer;
}

/** Exit state lives on the child, so a later child that reuses a numeric pid has none. */
interface DaemonTracker {
  pid: number;
  state: DaemonExitState;
  exited: Promise<DaemonExit>;
}

type TrackedChild = ChildProcess & { tracker: DaemonTracker };

/** Report timers still pending, so a test can prove a losing one was cleared. */
const reportTimers = new Set<NodeJS.Timeout>();
/** How many report deadlines fired, so a test can prove a cancelled timer never ran. */
let reportTimerFires = 0;

/** The log's size before an attempt, so only that attempt's lines are read. */
function logSize(): number {
  try {
    return statSync(logFile).size;
  } catch {
    return 0;
  }
}

/** The log written since `offset`. */
function logSince(offset: number): string {
  try {
    return readFileSync(logFile).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

function prepareBranch(port: number): { branch: TpsKeyPair; host: TpsKeyPair } {
  const branch = generateKeyPair();
  const host = generateKeyPair();
  saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
  writeFileSync(
    join(process.env.TPS_IDENTITY_DIR!, "host.json"),
    JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
  );
  writeBranchConf(port, "127.0.0.1", "tcp", undefined, "agent-a");
  return { branch, host };
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

/** Resolve with `promise`, or null when `timeoutMs` passes first; a winning promise cancels the timer. */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      reportTimerFires += 1;
      reportTimers.delete(timer);
      resolveWait(null);
    }, timeoutMs);
    reportTimers.add(timer);
    promise.then((value) => {
      clearTimeout(timer);
      reportTimers.delete(timer);
      resolveWait(value);
    });
  });
}

/** The daemon's exit status and stderr tail, for a wait that lost its daemon. */
async function daemonExitReport(daemon: DaemonTracker | undefined): Promise<string> {
  if (daemon === undefined) return "daemon pid unknown";
  const recorded = daemon.state.status ?? (await settleWithin(daemon.exited, EXIT_REPORT_MS));
  const status =
    recorded === null
      ? "exit status not captured"
      : recorded.signal !== null
        ? `killed by ${recorded.signal}`
        : `exit code ${String(recorded.code)}`;
  const tail = daemon.state.stderr.toString("utf8").trim();
  return `daemon ${daemon.pid} ${status}; stderr tail: ${tail === "" ? "(empty)" : tail}`;
}

/** The pause file a wait accepts: the daemon's own exact name, or any for a phase without one. */
function pauseFile(phase: string, pid: number | undefined): string | undefined {
  const entries = readdirSync(pauseDir);
  if (pid === undefined) return entries.find((entry) => entry.startsWith(`ready-${phase}-`));
  const name = `ready-${phase}-${pid}`;
  return entries.includes(name) ? name : undefined;
}

/**
 * Wait for `phase`'s pause file. With the daemon's tracker, the file waited for
 * is that child's own exact name, so a sibling pid that shares a prefix cannot
 * satisfy it, and a daemon that has exited can never write it: the wait then
 * fails at once, naming the exit status and the stderr tail, instead of
 * waiting out the timeout for a file that can no longer appear.
 */
async function waitForReady(
  phase: string,
  daemon?: DaemonTracker,
  failure?: () => Error | undefined,
): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const failed = failure?.();
    if (failed) throw failed;
    const name = pauseFile(phase, daemon?.pid);
    if (name !== undefined) return join(pauseDir, name);
    if (daemon !== undefined && (daemon.state.status !== null || pidExited(daemon.pid))) {
      // A daemon may write its file and then exit; check once more before
      // reporting the pause as never written.
      const late = pauseFile(phase, daemon.pid);
      if (late !== undefined) return join(pauseDir, late);
      throw new Error(`pause ${phase} never appeared: ${await daemonExitReport(daemon)}; ${daemonState(daemon.pid)}`);
    }
    if (Date.now() >= deadline) {
      const failed = failure?.();
      if (failed) throw failed;
      throw new Error(`timed out waiting for pause ${phase}; ${daemonState(daemon?.pid)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
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

async function waitForLogStarted(offset = 0, failure?: () => Error | undefined): Promise<void> {
  await waitFor(
    () => {
      const failed = failure?.();
      if (failed) throw failed;
      try {
        return logSince(offset).includes("STARTED") ? true : null;
      } catch {
        return null;
      }
    },
    "daemon STARTED log line",
  );
}

/** Wait until only the daemon answers a bounded Noise handshake under the
 *  branch key it was started with; a foreign listener that holds the port
 *  cannot answer it. The attempt's failure predicate is checked before every
 *  wait and before any deadline throw. */
async function waitForDaemonReady(
  port: number,
  branch: TpsKeyPair,
  host: TpsKeyPair,
  failure?: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const failed = failure?.();
    if (failed) throw failed;
    const transport = new NoiseIkTransport(host);
    const pending = transport.connect({
      host: "127.0.0.1",
      port,
      branchId: "agent-a",
      hostPublicKey: branch.encryption.publicKey,
    });
    pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const channel = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("connect attempt did not settle")), 500);
        }),
      ]);
      await channel.close();
      return;
    } catch {
      transport.close();
      void pending.then((channel) => channel.close()).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) {
      const failed = failure?.();
      if (failed) throw failed;
      throw new Error(`daemon did not answer a Noise handshake on 127.0.0.1:${port}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return true;
    throw error;
  }
}

async function waitForPidGone(pid: number): Promise<void> {
  await waitFor(() => (pidExited(pid) ? true : null), `pid ${pid} to exit`);
}

/** Track one child: exit status on both `exit` and `close`, and a byte-bounded stderr tail. */
function trackDaemon(child: ChildProcess, pid = child.pid): TrackedChild {
  if (pid === undefined) throw new Error("spawned child has no pid");
  const state: DaemonExitState = { status: null, stderr: Buffer.alloc(0) };
  let resolveExited!: (exit: DaemonExit) => void;
  const exited = new Promise<DaemonExit>((resolveWait) => {
    resolveExited = resolveWait;
  });
  const record = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (state.status !== null) return;
    state.status = { code, signal };
    resolveExited(state.status);
  };
  // "exit" fires when the process ends; "close" waits for piped stdio to
  // drain, which a grandchild inheriting stderr can hold open indefinitely.
  child.once("exit", record);
  child.once("close", record);
  child.stderr?.on("data", (chunk: Buffer) => {
    const tail = Buffer.concat([state.stderr, chunk]);
    state.stderr = tail.length > STDERR_TAIL_BYTES ? tail.subarray(tail.length - STDERR_TAIL_BYTES) : tail;
  });
  const tracked = child as TrackedChild;
  tracked.tracker = { pid, state, exited };
  return tracked;
}

function spawnDaemon(phase: string, onStderr: (text: string) => void = () => {}): TrackedChild {
  const env = pauseEnv(phase);
  env.TPS_BRANCH_NO_DAEMON = "1";
  delete env.TPS_BRANCH_DAEMON;
  const child = trackDaemon(spawn("node", [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] }));
  child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
  children.push(child);
  return child;
}

/** One daemon start on `port`: only this attempt's log lines and stderr are
 *  read, and a failed child is killed before the caller retries. */
async function startDaemonAttempt(port: number, phase: string, readyBeforeListening: boolean): Promise<TrackedChild> {
  const { branch, host } = prepareBranch(port);
  const offset = logSize();
  let stderr = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const daemon = spawnDaemon(phase, (text) => {
    stderr += text;
  });
  daemon.once("close", (code, signal) => {
    exited = { code, signal };
  });
  const failure = (): Error | undefined => {
    const output = logSince(offset) + stderr;
    const bind = bindErrorIn(output);
    if (bind) return bind;
    if (exited !== null && exited.code !== 0) {
      return new Error(`daemon exited (code ${exited.code}) before listening: ${output}`);
    }
    return undefined;
  };
  try {
    await waitForLogStarted(offset, failure);
    if (readyBeforeListening) await waitForReady(phase, daemon.tracker, failure);
    await waitForDaemonReady(port, branch, host, failure);
    return daemon;
  } catch (error) {
    try {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForExit(daemon).catch(() => {});
    throw error;
  }
}

/** Start a daemon from config, retrying on a new port when the chosen one is taken. */
async function startDaemonOnPort(
  phase: string,
  options: { firstPort?: number; readyBeforeListening?: boolean } = {},
): Promise<{ daemon: TrackedChild; port: number; attempts: number }> {
  let attempts = 0;
  const { port, result } = await withPortRetry(
    async (port) => {
      attempts += 1;
      return await startDaemonAttempt(port, phase, options.readyBeforeListening === true);
    },
    { firstPort: options.firstPort },
  );
  return { daemon: result, port, attempts };
}

function reapedPid(): number {  const child = spawnSync("true", []);
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
  const { daemon, port } = await startDaemonOnPort("shutdown-before-unlink");
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
  await waitForReady("shutdown-before-unlink", daemon.tracker);
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
  prepareBranch(0);
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
    for (const timer of reportTimers) clearTimeout(timer);
    reportTimers.clear();
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
    prepareBranch(0);
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
    const port = 0;
    prepareBranch(port);
    const phase = "startup-before-listener";
    const daemon = spawnDaemon(phase);
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
    await waitForReady(phase, daemon.tracker);
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
    const phase = "listening-before-steady-state";
    const { port, daemon } = await startDaemonOnPort(phase, { readyBeforeListening: true });
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
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

  test("a daemon that exits before its pause point fails the wait at once and names its exit status", async () => {
    // No prepareBranch: without branch.conf.json the daemon refuses at startup,
    // before the listener and before the pause file, so the wait has to fail on
    // the exit itself and carry the status and stderr, not wait out WAIT_MS.
    const phase = "listening-before-steady-state";
    const daemon = spawnDaemon(phase);
    const started = Date.now();
    const failure = await waitForReady(phase, daemon.tracker).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain(`pause ${phase} never appeared`);
    expect(failure!.message).toContain("exit code 1");
    expect(failure!.message).toContain("branch.conf.json not found");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 40_000);

  test("a pause file whose pid merely shares a prefix is not accepted", async () => {
    const phase = "exact-pause-name";
    const daemon = trackDaemon(
      spawn("node", ["-e", "setTimeout(() => process.exit(1), 100)"], { stdio: ["ignore", "ignore", "pipe"] }),
    );
    children.push(daemon);
    expect(daemon.pid).toBeDefined();
    writeFileSync(join(pauseDir, `ready-${phase}-${daemon.pid}0`), "");

    const failure = await waitForReady(phase, daemon.tracker).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain(`pause ${phase} never appeared`);
    expect(failure!.message).toContain("exit code 1");
  }, 20_000);

  test("a stale exit record for a reused pid does not reject a live daemon", async () => {
    const phase = "reused-pid";
    // The dead child is tracked under the live child's numeric pid, as a reused
    // OS pid would be: the dead child's record must stay on its own tracker,
    // not on the number, or the live wait rejects before its pause file appears.
    const live = trackDaemon(
      spawn("node", ["-e", "setTimeout(() => {}, 30_000)"], { stdio: ["ignore", "ignore", "pipe"] }),
    );
    children.push(live);
    const pid = live.pid!;
    const dead = trackDaemon(
      spawn("node", ["-e", "process.exit(7)"], { stdio: ["ignore", "ignore", "pipe"] }),
      pid,
    );
    children.push(dead);
    expect(await dead.tracker.exited).toEqual({ code: 7, signal: null });

    const name = `ready-${phase}-${pid}`;
    const appear = new Promise<void>((resolveAppear) => {
      setTimeout(() => {
        writeFileSync(join(pauseDir, name), "");
        resolveAppear();
      }, 100);
    });
    expect(await waitForReady(phase, live.tracker)).toBe(join(pauseDir, name));
    await appear;
  }, 20_000);

  test("an exit with stderr still held open reports the exit code", async () => {
    const phase = "held-stderr";
    const grandchildFile = join(root, "grandchild.pid");
    // The detached grandchild inherits stderr, so the parent's piped stderr
    // never drains: only the "exit" event carries the status.
    const script = `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        detached: true,
        stdio: ["ignore", "ignore", "inherit"],
      });
      writeFileSync(${JSON.stringify(grandchildFile)}, String(grandchild.pid));
      process.exit(3);
    `;
    const daemon = trackDaemon(
      spawn("node", ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] }),
    );
    children.push(daemon);
    let grandchildPid = 0;
    try {
      grandchildPid = await waitFor(
        () => {
          try {
            return Number(readFileSync(grandchildFile, "utf8"));
          } catch {
            return null;
          }
        },
        "detached grandchild pid",
      );

      const failure = await waitForReady(phase, daemon.tracker).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure!.message).toContain("exit code 3");
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  test("a multi-byte stderr flood keeps the tail within 4096 bytes", async () => {
    const script = 'process.stderr.write("€".repeat(5000)); process.exit(4);';
    const daemon = trackDaemon(spawn("node", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] }));
    children.push(daemon);

    expect(await waitForExit(daemon)).toEqual({ code: 4, signal: null });
    expect(daemon.tracker.state.stderr.length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(daemon.tracker.state.stderr.toString("utf8")).toContain("€");
  }, 20_000);

  test("a report that settles inside the deadline cancels its timer", async () => {
    const state: DaemonExitState = { status: null, stderr: Buffer.alloc(0) };
    let resolveExited!: (exit: DaemonExit) => void;
    const exited = new Promise<DaemonExit>((resolveWait) => {
      resolveExited = resolveWait;
    });
    const firedBefore = reportTimerFires;
    const report = daemonExitReport({ pid: 4321, state, exited });
    resolveExited({ code: 0, signal: null });

    expect(await report).toContain("exit code 0");
    expect(reportTimers.size).toBe(0);
    // The losing deadline must not fire after the exit has already landed.
    await new Promise((resolveWait) => setTimeout(resolveWait, EXIT_REPORT_MS + 50));
    expect(reportTimerFires).toBe(firedBefore);
  }, 20_000);

  test("a second signal during shutdown does not run the shutdown path twice", async () => {
    const phase = "shutdown-after-signal";
    const { port, daemon } = await startDaemonOnPort(phase);
    daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");
    await waitForReady(phase, daemon.tracker);
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
    prepareBranch(0);
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
    prepareBranch(0);
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

  test("a matching token with a pause dir outside TPS_TEST_ROOT is ignored", async () => {
    prepareBranch(0);
    const outsideBase = dirname(realpathSync(process.env.TPS_TEST_ROOT!));
    const outside = mkdtempSync(join(outsideBase, "tps-branch-730-outside-"));
    try {
      const env = launcherEnv("unused");
      delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
      env.TPS_BRANCH_TEST_PAUSE_DIR = outside;
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
      expect(readdirSync(outside)).toEqual([]);

      process.kill(running.pid, "SIGTERM");
      await waitForPidGone(running.pid);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 40_000);

  test("a registered daemon whose start token changed is reported and not signalled", async () => {
    prepareBranch(0);
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
    prepareBranch(0);
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
    const phase = "shutdown-before-unlink";
    const { port, daemon } = await startDaemonOnPort(phase);
    expect(daemon.pid).toBeDefined();
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    // The daemon installs its shutdown handlers before it opens the listener,
    // so a SIGTERM sent now reaches its shutdown path (cli#744).
    daemon.kill("SIGTERM");
    await waitForReady(phase, daemon.tracker);

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
    prepareBranch(0);
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
    prepareBranch(0);
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
    prepareBranch(0);
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
    prepareBranch(0);
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
    // Printed once: office kill reports each failure once (cli#742).
    expect(stderr.split(/\r?\n/).filter((line) => line !== "")).toEqual([
      `Branch pid file ${pidFile} was replaced; the branch pid file was not removed.`,
    ]);
    expect(existsSync(hostPath)).toBe(false);
    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
  }, 40_000);

  test("office kill's final read compares raw bytes and preserves a byte-only replacement", async () => {
    prepareBranch(0);
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

  test("a daemon start retries onto a free port after its first port is taken", async () => {
    const held = await holdPort();
    try {
      const { daemon, attempts } = await startDaemonOnPort("unused", { firstPort: held.port });
      daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(PORT_ATTEMPTS);
      expect(pidState(daemon.pid!)).toBe("alive");
      const exited = waitForExit(daemon);
      daemon.kill("SIGTERM");
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      await held.close();
    }
  }, 40_000);

  test("a paused start retries onto a free port after its first port is taken", async () => {
    const held = await holdPort();
    const phase = "listening-before-steady-state";
    try {
      const { daemon, attempts } = await startDaemonOnPort(phase, {
        firstPort: held.port,
        readyBeforeListening: true,
      });
      daemons.push({ pid: daemon.pid!, startToken: startToken(daemon.pid!) });
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(PORT_ATTEMPTS);
      writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
      const exited = waitForExit(daemon);
      daemon.kill("SIGTERM");
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(stoppedCount()).toBe(1);
      expect(readPidFile(pidFile).kind).toBe("missing");
      expect(pidExited(daemon.pid!)).toBe(true);
    } finally {
      await held.close();
    }
  }, 40_000);

  let unannouncedDaemon: { pid: number; startToken: string } | undefined;

  test("afterEach stops a launcher's daemon when its announcement is not read", async () => {
    prepareBranch(0);
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
