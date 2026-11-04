import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
import { writeBranchConf } from "../src/commands/branch.js";
import { readPidFile, serializePidRecord } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 10_000;

let root: string;
let pidFile: string;
let logFile: string;
let savedEnv: Record<string, string | undefined>;
const daemons: number[] = [];
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

async function waitForLogStarted(): Promise<void> {
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

async function waitForRunningRecord(): Promise<{ pid: number; startToken: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = readPidFile(pidFile);
    if (state.kind === "running") return { pid: state.pid, startToken: state.startToken };
    if (Date.now() >= deadline) throw new Error(`pid file did not name a running process; last state=${JSON.stringify(state)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (pidState(pid) !== "gone") {
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0] === "Z") return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      }
    }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} was still alive after the wait bound`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function spawnDaemon(): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
  delete env.TPS_BRANCH_DAEMON;
  const child = spawn("node", [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  return child;
}

/** The launcher path is skipped under NODE_ENV=test; a real launcher child must
 *  not inherit the test flag. */
function launcherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_ENV;
  delete env.TPS_BRANCH_DAEMON;
  delete env.TPS_BRANCH_NO_DAEMON;
  return env;
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
    if (connected) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      return;
    }
    if (Date.now() >= deadline) throw new Error(`daemon did not listen on 127.0.0.1:${port}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function reapedPid(): number {
  const child = spawnSync("true", []);
  if (child.pid === undefined) throw new Error("could not spawn a helper process");
  if (pidState(child.pid) !== "gone") throw new Error("helper pid was reused; rerun the test");
  return child.pid;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ["HOME", "TPS_ROOT", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_AGENT_ID", "TPS_VAULT_KEY"]) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), "tps-branch-726-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
  process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  process.env.TPS_AGENT_ID = "agent-a";
  process.env.TPS_VAULT_KEY = "branch-726-test";
  pidFile = join(root, ".tps", "branch.pid");
  logFile = join(root, ".tps", "branch.log");
});

afterEach(async () => {
  for (const pid of daemons.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("branch start single-daemon guard (cli#726)", () => {
  test("a second start is refused while a verified daemon runs and spawns nothing", async () => {
    const port = await freePort();
    prepareBranch(port);
    const first = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(first.status).toBe(0);
    const running = await waitForRunningRecord();
    daemons.push(running.pid);
    const recordBefore = readFileSync(pidFile, "utf8");

    const second = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain(`pid ${running.pid}`);
    expect(second.stderr).toContain(pidFile);
    expect(second.stdout).not.toContain("Branch daemon started");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 30_000);

  test("a stale record is replaced and the start proceeds", async () => {
    const port = await freePort();
    prepareBranch(port);
    const stalePid = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stalePid, null));

    const started = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(started.status).toBe(0);
    expect(started.stdout).toContain("Branch daemon started");
    const running = await waitForRunningRecord();
    daemons.push(running.pid);
    expect(running.pid).not.toBe(stalePid);

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 30_000);

  test("an unverified live record is refused with the stop remedy", async () => {
    const port = await freePort();
    prepareBranch(port);
    const live = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(live);
    expect(live.pid).toBeDefined();
    const contents = serializePidRecord(live.pid!, null);
    writeFileSync(pidFile, contents);

    const refused = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`names pid ${live.pid}`);
    expect(refused.stderr).toContain("Check that pid and stop it yourself, or remove");
    expect(refused.stderr).toContain(pidFile);
    expect(refused.stdout).not.toContain("Branch daemon started");
    expect(readFileSync(pidFile, "utf8")).toBe(contents);
  }, 30_000);

  test("an invalid record is refused naming the path and reason", async () => {
    const port = await freePort();
    prepareBranch(port);
    writeFileSync(pidFile, "not a pid\n");

    const refused = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(pidFile);
    expect(refused.stderr).toContain("pid is not a whole positive decimal integer");
    expect(refused.stdout).not.toContain("Branch daemon started");
  }, 30_000);

  test("an unreadable record is refused naming the path and reason", async () => {
    const port = await freePort();
    prepareBranch(port);
    mkdirSync(pidFile, { recursive: true });

    const refused = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(pidFile);
    expect(refused.stderr).toContain("is not a regular file");
    expect(refused.stdout).not.toContain("Branch daemon started");
  }, 30_000);

  test("a daemon leaves a replacement record in place on shutdown", async () => {
    const port = await freePort();
    prepareBranch(port);
    const daemon = spawnDaemon();
    await waitForLogStarted();
    await waitForListening(port);
    expect(daemon.pid).toBeDefined();

    const newer = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore"] });
    children.push(newer);
    expect(newer.pid).toBeDefined();
    const replacement = serializePidRecord(newer.pid!, startToken(newer.pid!));
    writeFileSync(pidFile, replacement);

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");
    const exit = await exited;
    expect(exit).toEqual({ code: 0, signal: null });

    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    const state = readPidFile(pidFile);
    expect(state.kind).toBe("running");
    if (state.kind === "running") expect(state.pid).toBe(newer.pid);
    expect(readFileSync(logFile, "utf8")).toContain("now names another process");
  }, 30_000);

  test("a daemon removes its own record on shutdown", async () => {
    const port = await freePort();
    prepareBranch(port);
    const daemon = spawnDaemon();
    await waitForLogStarted();
    await waitForListening(port);
    expect(daemon.pid).toBeDefined();
    writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
    expect(readPidFile(pidFile).kind).toBe("running");

    const exited = waitForExit(daemon);
    daemon.kill("SIGTERM");
    const exit = await exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(pidFile)).toBe(false);
  }, 30_000);
});
