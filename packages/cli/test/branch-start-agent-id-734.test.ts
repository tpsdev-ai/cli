/**
 * cli#734 — both branch launchers resolve the branch agent id before the
 * pid-record check, so a start that cannot run names the missing id instead of
 * a running recorded process. These tests drive the real CLI with real files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const spawnedPids: number[] = [];
const allSpawnedPids: number[] = [];
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

function track(child: ChildProcess): ChildProcess {
  if (child.pid !== undefined) {
    spawnedPids.push(child.pid);
    allSpawnedPids.push(child.pid);
  }
  spawnedChildren.push(child);
  return child;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = track(spawn("node", [TPS_BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
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
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
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
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("branch launchers resolve the agent id before the pid record (cli#734)", () => {
  test("a start with both agent-id sources cleared names the missing id, not the running pid", async () => {
    const port = await freePort();
    prepareBranch(port, "agent-a");
    const first = await runCli(["branch", "start"], launcherEnv());
    expect(first.code).toBe(0);
    const running = await waitForRunningRecord();
    spawnedPids.push(running.pid);
    allSpawnedPids.push(running.pid);
    await waitForLogStarted();

    writeBranchConf(port, "127.0.0.1", "tcp", undefined, undefined);
    const recordBefore = readFileSync(pidFile, "utf8");

    const second = await runCli(["branch", "start"], launcherEnv());

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("no branch agent id");
    expect(second.stderr).not.toContain(`Recorded process (pid ${running.pid}`);
    expect(second.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");
  }, 40_000);

  test("a start with the agent id configured still refuses naming the pid, pid file and stop remedy", async () => {
    const port = await freePort();
    prepareBranch(port, "agent-a");
    const first = await runCli(["branch", "start"], launcherEnv());
    expect(first.code).toBe(0);
    const running = await waitForRunningRecord();
    spawnedPids.push(running.pid);
    allSpawnedPids.push(running.pid);
    await waitForLogStarted();
    const recordBefore = readFileSync(pidFile, "utf8");

    const second = await runCli(["branch", "start"], launcherEnv());

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(`pid ${running.pid}`);
    expect(second.stderr).toContain(pidFile);
    expect(second.stderr).toContain(
      `If pid ${running.pid} is the branch daemon, stop it with "tps branch stop"; otherwise remove ${pidFile} only after confirming no branch daemon is running.`,
    );
    expect(second.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");
  }, 40_000);

  test("a start with no record and no agent id names the missing id", async () => {
    const port = await freePort();
    prepareBranch(port, undefined);

    const result = await runCli(["branch", "start"], launcherEnv());

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no branch agent id");
    expect(result.stdout).not.toContain("Branch daemon spawned");
    expect(existsSync(pidFile)).toBe(false);
  }, 20_000);

  test("a production init with no agent id names it before the pid record and writes nothing", async () => {
    const port = await freePort();
    const live = startSleep();
    writeFileSync(pidFile, serializePidRecord(live.pid!, startToken(live.pid!)));
    const recordBefore = readFileSync(pidFile, "utf8");

    const result = await runCli(
      ["branch", "init", "--listen", String(port), "--host", "127.0.0.1", "--transport", "tcp"],
      launcherEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no branch agent id");
    expect(result.stdout).not.toContain("Waiting for host to connect");
    expect(result.stdout).not.toContain("Branch daemon spawned");
    expect(existsSync(join(tpsRoot, "branch.conf.json"))).toBe(false);
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(live.pid!)).toBe("alive");
  }, 20_000);
});

afterAll(() => {
  const leaked = allSpawnedPids.filter((pid) => !pidGone(pid));
  expect(leaked).toEqual([]);
});
