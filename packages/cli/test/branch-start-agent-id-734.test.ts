import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
import { writeBranchConf } from "../src/commands/branch.js";
import { readPidFile, serializePidRecord } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 10_000;
const CLI_MS = 20_000;

let root: string;
let tpsRoot: string;
let pidFile: string;
let savedEnv: Record<string, string | undefined>;
// Pids of processes this test spawned directly (launcher children, sleeps).
const spawnedPids: number[] = [];
const allSpawnedPids: number[] = [];
// Pids read from a pid record, verified by stopRecordedDaemons before it signals them.
const recordedDaemons: { pid: number; startToken: string }[] = [];
const leakCheckPids: number[] = [];
const unverifiedIdentityPids = new Set<number>();
const spawnedChildren: ChildProcess[] = [];

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

function prepareBranch(port: number, agentId?: string): void {
  const branch = generateKeyPair();
  const host = generateKeyPair();
  saveKeyPair(branch, process.env.TPS_IDENTITY_DIR!, "branch");
  writeFileSync(
    join(process.env.TPS_IDENTITY_DIR!, "host.json"),
    JSON.stringify({ publicKey: Buffer.from(host.encryption.publicKey).toString("base64url") }),
  );
  writeBranchConf(port, "127.0.0.1", "tcp", undefined, agentId);
}

function launcherEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_ENV;
  delete env.TPS_BRANCH_DAEMON;
  delete env.TPS_BRANCH_NO_DAEMON;
  delete env.TPS_AGENT_ID;
  delete env.TPS_BRANCH_TEST_PAUSE_DIR;
  delete env.TPS_BRANCH_TEST_PAUSE_PHASE;
  return Object.assign(env, extra);
}

function rememberPid(pid: number): void {
  if (!spawnedPids.includes(pid)) spawnedPids.push(pid);
  if (!allSpawnedPids.includes(pid)) allSpawnedPids.push(pid);
}

function track(child: ChildProcess): ChildProcess {
  if (child.pid !== undefined) rememberPid(child.pid);
  spawnedChildren.push(child);
  return child;
}

function rememberRecordedDaemon(pid: number, token: string): void {
  if (!recordedDaemons.some((record) => record.pid === pid)) recordedDaemons.push({ pid, startToken: token });
}

/** Register the pid the launcher recorded, before the launcher-result assertion. */
function registerRecordedPid(): void {
  const state = readPidFile(pidFile);
  if (state.kind === "running") rememberRecordedDaemon(state.pid, state.startToken);
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  stopAfterIdentity = false,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = track(spawn("node", [TPS_BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
    if (stopAfterIdentity && stdout.includes("Branch identity created")) child.kill("SIGKILL");
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, CLI_MS);
  // Resolve on "close", not "exit": "exit" can fire while the piped stdout and
  // stderr are still open, so the captured output could be short. The daemon
  // spawns with its own stdio (packages/cli/src/commands/branch.ts:225), so
  // "close" does not wait for the daemon.
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  return { ...exit, stdout, stderr };
}

function startToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

function startSleep(): ChildProcess {
  const child = track(spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] }));
  if (child.pid === undefined) throw new Error("sleep has no pid");
  return child;
}

function runningRefusal(pid: number): string {
  return `Recorded process (pid ${pid}, start token matches) is still running; refusing to spawn (pid file ${pidFile}). If pid ${pid} is the branch daemon, stop it with "tps branch stop"; otherwise remove ${pidFile} only after confirming no branch daemon is running.`;
}

async function waitForRunningRecord(): Promise<{ pid: number; startToken: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = readPidFile(pidFile);
    if (state.kind === "running") return { pid: state.pid, startToken: state.startToken };
    if (Date.now() >= deadline) throw new Error(`pid file did not name a running process; last state=${JSON.stringify(state)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function waitForLogStarted(): Promise<void> {
  const logFile = join(tpsRoot, "branch.log");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(logFile, "utf8");
    } catch {
      /* not created yet */
    }
    if (text.includes("STARTED")) return;
    if (Date.now() >= deadline) throw new Error(`daemon did not log STARTED; log=${text}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function leakDiagnostic(pids: number[]): string {
  return pids
    .map((pid) => unverifiedIdentityPids.has(pid) ? `identity could not be verified for pid ${pid}` : `pid ${pid} is still alive`)
    .join("; ");
}

function pidGone(pid: number): boolean {
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
  const deadline = Date.now() + WAIT_MS;
  while (!pidGone(pid)) {
    if (Date.now() >= deadline) throw new Error(`pid ${pid} was still alive after the wait bound`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

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

function runsTestDaemon(pid: number): boolean {
  let command: string | null;
  let environ: string | null = null;
  try {
    if (process.platform === "linux") {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    } else {
      command = (() => {
        const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
        return ps.status === 0 ? ps.stdout : null;
      })();
    }
  } catch {
    return false;
  }
  if (command === null) return false;
  if (process.platform !== "linux") {
    if (command.trim() !== "tps" && !command.includes(TPS_BIN)) return false;
    try {
      const stdout = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "1", "-Fn"], { encoding: "utf8" });
      if (stdout.status !== 0) return false;
      const name = stdout.stdout.split("\n").find((line) => line.startsWith("n"));
      if (name === undefined) return false;
      const stdoutPath = realpathSync(name.slice(1));
      return stdoutPath.startsWith(`${realpathSync(root)}${sep}`) && statSync(stdoutPath).isFile();
    } catch {
      return false;
    }
  }
  const entries = environ!.split("\0");
  if (!entries.includes(`HOME=${root}`) || !entries.includes("TPS_BRANCH_DAEMON=1")) return false;
  return command === "tps" || command.includes(TPS_BIN);
}

/** stopRecordedDaemons verifies a recorded pid's start token and identity as this
 *  root's daemon before signalling it. It leaves unverified pids unsignalled and
 *  records them for leakDiagnostic. */
async function stopRecordedDaemons(): Promise<void> {
  const failures: string[] = [];
  const seen = new Set<number>();
  const stopVerified = async (pid: number): Promise<void> => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (pidState(pid) !== "gone") {
        failures.push(`could not kill pid ${pid}: ${(error as Error).message}`);
      }
    }
    try {
      await waitForPidGone(pid);
    } catch (error) {
      failures.push((error as Error).message);
    }
  };
  for (const path of new Set([pidFile, ...recordFilesUnder(root)])) {
    const state = readPidFile(path);
    if (state.kind === "missing" || state.kind === "unreadable" || state.kind === "invalid" || state.kind === "stale") continue;
    seen.add(state.pid);
    if (!leakCheckPids.includes(state.pid)) leakCheckPids.push(state.pid);
    if (state.kind === "unverified" || !runsTestDaemon(state.pid)) {
      unverifiedIdentityPids.add(state.pid);
      continue;
    }
    await stopVerified(state.pid);
  }
  for (const record of recordedDaemons) {
    if (seen.has(record.pid) || pidGone(record.pid)) continue;
    if (!leakCheckPids.includes(record.pid)) leakCheckPids.push(record.pid);
    if (processStartToken(record.pid) !== record.startToken || !runsTestDaemon(record.pid)) {
      unverifiedIdentityPids.add(record.pid);
      continue;
    }
    await stopVerified(record.pid);
  }
  if (failures.length > 0) throw new Error(`recorded-daemon cleanup failed: ${failures.join("; ")}`);
}

async function stopTracked(): Promise<void> {
  const pids = spawnedPids.splice(0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const child of spawnedChildren.splice(0)) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const pid of pids) {
    await waitForPidGone(pid).catch(() => {});
  }
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY"]) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), "tps-branch-734-"));
  tpsRoot = join(root, ".tps");
  process.env.HOME = root;
  process.env.TPS_ROOT = tpsRoot;
  process.env.TPS_IDENTITY_DIR = join(tpsRoot, "identity");
  process.env.TPS_REGISTRY_DIR = join(tpsRoot, "registry");
  process.env.TPS_VAULT_KEY = "branch-734-test";
  delete process.env.TPS_AGENT_ID;
  pidFile = join(tpsRoot, "branch.pid");
  mkdirSync(tpsRoot, { recursive: true });
});

afterEach(async () => {
  await stopTracked();
  let cleanupError: unknown;
  try {
    await stopRecordedDaemons();
  } catch (error) {
    cleanupError = error;
  } finally {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
});

describe("branch start and init recorded-process refusals (cli#734)", () => {
  test("a start with a running recorded process and both agent-id sources cleared names the running pid and the pid file", async () => {
    const port = await freePort();
    prepareBranch(port, "agent-a");
    const first = await runCli(["branch", "start"], launcherEnv());
    registerRecordedPid();
    expect(first.code).toBe(0);
    const running = await waitForRunningRecord();
    rememberRecordedDaemon(running.pid, running.startToken);
    await waitForLogStarted();

    writeBranchConf(port, "127.0.0.1", "tcp", undefined, undefined);
    const recordBefore = readFileSync(pidFile, "utf8");

    const second = await runCli(["branch", "start"], launcherEnv());

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(runningRefusal(running.pid));
    expect(second.stderr).not.toContain("no branch agent id");
    expect(second.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");
  }, 40_000);

  test.each([false, true])("a production init with a running recorded process names the pid and pid file before joining (agent id configured: %s)", async (configured) => {
    const port = await freePort();
    const agentId = configured ? "agent-a" : undefined;
    prepareBranch(port, agentId);
    const live = startSleep();
    writeFileSync(pidFile, serializePidRecord(live.pid!, startToken(live.pid!)));
    const recordBefore = readFileSync(pidFile, "utf8");
    const confBefore = readFileSync(join(tpsRoot, "branch.conf.json"), "utf8");
    const seedBefore = readFileSync(join(process.env.TPS_IDENTITY_DIR!, "branch.seed"));

    const result = await runCli(
      ["branch", "init", "--force", "--listen", String(port), "--host", "127.0.0.1", "--transport", "tcp"],
      launcherEnv(agentId ? { TPS_AGENT_ID: agentId } : {}),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(runningRefusal(live.pid!));
    expect(result.stderr).not.toContain("no branch agent id");
    expect(result.stdout).not.toContain("Waiting for host to connect");
    expect(result.stdout).not.toContain("Branch identity created");
    expect(readFileSync(join(tpsRoot, "branch.conf.json"), "utf8")).toBe(confBefore);
    expect(readFileSync(join(process.env.TPS_IDENTITY_DIR!, "branch.seed"))).toEqual(seedBefore);
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(live.pid!)).toBe("alive");
  }, 20_000);

  test("a production init with no agent id or recorded process creates the branch identity", async () => {
    const result = await runCli(["branch", "init", "--name", "smoke-test"], launcherEnv(), true);

    expect(result.stdout).toContain("Branch identity created");
    expect(result.stderr).not.toContain("no branch agent id");
    expect(existsSync(join(process.env.TPS_IDENTITY_DIR!, "branch.seed"))).toBe(true);
    expect(JSON.parse(readFileSync(join(tpsRoot, "branch.conf.json"), "utf8")).agentId).toBeUndefined();
    expect(existsSync(pidFile)).toBe(false);
  }, 25_000);

  test("a start with no recorded process and no agent id names the missing id", async () => {
    const port = await freePort();
    prepareBranch(port, undefined);

    const result = await runCli(["branch", "start"], launcherEnv());

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no branch agent id");
    expect(result.stdout).not.toContain("Branch daemon spawned");
    expect(existsSync(pidFile)).toBe(false);
  }, 20_000);

  test("a start with a running recorded process and the agent id configured names the running pid", async () => {
    const port = await freePort();
    prepareBranch(port, "agent-a");
    const first = await runCli(["branch", "start"], launcherEnv());
    registerRecordedPid();
    expect(first.code).toBe(0);
    const running = await waitForRunningRecord();
    rememberRecordedDaemon(running.pid, running.startToken);
    await waitForLogStarted();
    const recordBefore = readFileSync(pidFile, "utf8");

    const second = await runCli(["branch", "start"], launcherEnv());

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(runningRefusal(running.pid));
    expect(second.stderr).not.toContain("no branch agent id");
    expect(second.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");
  }, 40_000);

  test("stopRecordedDaemons leaves a foreign recorded pid unsignalled and marks its identity unverified", async () => {
    const foreignHome = join(root, "other-home");
    mkdirSync(foreignHome);
    const foreign = spawn("sleep", ["60"], {
      env: { ...process.env, HOME: foreignHome },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = foreign.pid;
    if (pid === undefined) throw new Error("sleep has no pid");
    try {
      writeFileSync(pidFile, serializePidRecord(pid, startToken(pid)));
      registerRecordedPid();

      await stopTracked();
      await stopRecordedDaemons();

      expect(pidGone(pid)).toBe(false);
      expect(leakDiagnostic([pid])).toBe(`identity could not be verified for pid ${pid}`);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForPidGone(pid).catch(() => {});
    }
  }, 20_000);

  test("stopRecordedDaemons stops the recorded daemon when the launcher announcement is discarded", async () => {
    const port = await freePort();
    prepareBranch(port, "agent-a");
    const launcher = spawn("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      launcher.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    expect(exited.code).toBe(0);
    const state = readPidFile(pidFile);
    if (state.kind !== "running" && state.kind !== "unverified") {
      throw new Error(`pid file did not name the launched daemon; state=${JSON.stringify(state)}`);
    }
    // stopRecordedDaemons must find this pid from the pid file.
    leakCheckPids.push(state.pid);
    await waitForLogStarted();
    expect(state.kind).toBe("running");
    expect(pidState(state.pid)).toBe("alive");
  }, 40_000);
});

afterAll(() => {
  const leaked = [...new Set([...allSpawnedPids, ...recordedDaemons.map((record) => record.pid), ...leakCheckPids])]
    .filter((pid) => !pidGone(pid));
  expect(leaked, leakDiagnostic(leaked)).toEqual([]);
});
