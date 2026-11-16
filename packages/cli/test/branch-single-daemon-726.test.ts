import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair, type TpsKeyPair } from "../src/utils/identity.js";
import { writeBranchConf } from "../src/commands/branch.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { bindErrorIn, holdPort, withPortRetry } from "./helpers/port.js";
import { pidRecordBytesEqual, readPidFile, serializePidRecord, snapshotPidRecord } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const WAIT_MS = 10_000;

let root: string;
let pidFile: string;
let logFile: string;
let savedEnv: Record<string, string | undefined>;
const daemons: number[] = [];
const children: ChildProcess[] = [];

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

/** Launch a real daemon and wait until it answers a Noise handshake on its port. */
async function startDaemonOnFreePort(
  firstPort?: number,
): Promise<{ running: { pid: number; startToken: string }; output: string; attempts: number }> {
  let attempts = 0;
  const { result } = await withPortRetry(
    async (port) => {
      attempts += 1;
      const { branch, host } = prepareBranch(port);
      const before = snapshotPidRecord(pidFile);
      const offset = logSize();
      const started = spawnSync("node", [TPS_BIN, "branch", "start"], {
        env: launcherEnv(),
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(started.status).toBe(0);
      const failure = (): Error | undefined => bindErrorIn(logSince(offset) + (started.stderr ?? ""));
      try {
        const running = await waitForRunningRecord(failure);
        await waitForDaemonReady(port, branch, host, failure);
        if (pidState(running.pid) !== "alive") throw new Error(`daemon ${running.pid} exited after start`);
        return { running, output: started.stdout ?? "" };
      } catch (error) {
        // Keep what the caller set up: remove only a record this attempt
        // wrote, and only after that attempt's process has stopped.
        const written = snapshotPidRecord(pidFile);
        const state = written.state;
        let stopped = state.kind === "stale";
        if (state.kind === "running") {
          try {
            process.kill(state.pid, "SIGKILL");
            await waitForPidGone(state.pid);
            stopped = true;
          } catch {
            /* not confirmed stopped: leave the record */
          }
        }
        if (stopped && !pidRecordBytesEqual(written.raw, before.raw)) {
          const after = snapshotPidRecord(pidFile);
          if (pidRecordBytesEqual(after.raw, written.raw)) rmSync(pidFile, { force: true });
        }
        throw error;
      }
    },
    { firstPort },
  );
  return { ...result, attempts };
}

async function startSpawnedDaemon(
  firstPort?: number,
): Promise<{ daemon: ChildProcess; port: number; attempts: number }> {
  let attempts = 0;
  const { port, result: daemon } = await withPortRetry(
    async (port) => {
      attempts += 1;
      const { branch, host } = prepareBranch(port);
      rmSync(pidFile, { force: true });
      const offset = logSize();
      let stderr = "";
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      const child = spawnDaemon((text) => {
        stderr += text;
      });
      child.once("close", (code, signal) => {
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
        await waitForDaemonReady(port, branch, host, failure);
        return child;
      } catch (error) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        await waitForExit(child).catch(() => {});
        throw error;
      }
    },
    { firstPort },
  );
  return { daemon, port, attempts };
}

async function waitForLogStarted(offset = 0, failure?: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const failed = failure?.();
    if (failed) throw failed;
    let text = "";
    try {
      text = logSince(offset);
    } catch {
      /* not created yet */
    }
    if (text.includes("STARTED")) return;
    if (Date.now() >= deadline) throw new Error(`daemon did not log STARTED; log=${text}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function waitForRunningRecord(
  failure?: () => Error | undefined,
): Promise<{ pid: number; startToken: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const failed = failure?.();
    if (failed) throw failed;
    const state = readPidFile(pidFile);
    if (state.kind === "running") return { pid: state.pid, startToken: state.startToken };
    if (Date.now() >= deadline) throw new Error(`pid file did not name a running process; last state=${JSON.stringify(state)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
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
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} was still alive after the wait bound`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function spawnDaemon(onStderr: (text: string) => void = () => {}): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, TPS_BRANCH_NO_DAEMON: "1" };
  delete env.TPS_BRANCH_DAEMON;
  const child = spawn("node", [TPS_BIN, "branch", "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
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
  test("a daemon start retries onto a free port after its first port is taken", async () => {
    const held = await holdPort();
    try {
      const { running, attempts } = await startDaemonOnFreePort(held.port);
      daemons.push(running.pid);
      expect(attempts).toBe(2);
      process.kill(running.pid, "SIGTERM");
      await waitForPidGone(running.pid);
    } finally {
      await held.close();
    }
  }, 30_000);

  test("a direct-spawn daemon retries onto a free port after its first port is taken", async () => {
    const held = await holdPort();
    try {
      const { daemon, attempts } = await startSpawnedDaemon(held.port);
      expect(attempts).toBe(2);
      expect(daemon.pid).toBeDefined();
      writeFileSync(pidFile, serializePidRecord(daemon.pid!, startToken(daemon.pid!)));
      const exited = waitForExit(daemon);
      daemon.kill("SIGTERM");
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await held.close();
    }
  }, 40_000);

  test("a second start is refused while the recorded process runs and spawns nothing", async () => {
    const { running } = await startDaemonOnFreePort();
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
    expect(second.stderr).toContain(
      `If pid ${running.pid} is the branch daemon, stop it with "tps branch stop"; otherwise remove ${pidFile} only after confirming no branch daemon is running.`,
    );
    expect(second.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(recordBefore);
    expect(pidState(running.pid)).toBe("alive");

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 30_000);

  test("a stale record is replaced on a successful launch", async () => {
    prepareBranch(0);
    const stalePid = reapedPid();
    writeFileSync(pidFile, serializePidRecord(stalePid, null));
    // The record is stale, not absent: the first launch must replace it.
    expect(readPidFile(pidFile).kind).toBe("stale");

    const { running, output } = await startDaemonOnFreePort();
    daemons.push(running.pid);
    expect(output).toContain("Branch daemon spawned");
    expect(running.pid).not.toBe(stalePid);

    process.kill(running.pid, "SIGTERM");
    await waitForPidGone(running.pid);
  }, 30_000);

  test("an unverified live record is refused with the stop remedy", async () => {
    prepareBranch(0);
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
    expect(refused.stdout).not.toContain("Branch daemon spawned");
    expect(readFileSync(pidFile, "utf8")).toBe(contents);
  }, 30_000);

  test("an invalid record is refused naming the path and reason", async () => {
    prepareBranch(0);
    writeFileSync(pidFile, "not a pid\n");

    const refused = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(pidFile);
    expect(refused.stderr).toContain("pid is not a whole positive decimal integer");
    expect(refused.stdout).not.toContain("Branch daemon spawned");
  }, 30_000);

  test("an unreadable record is refused naming the path and reason", async () => {
    prepareBranch(0);
    mkdirSync(pidFile, { recursive: true });

    const refused = spawnSync("node", [TPS_BIN, "branch", "start"], {
      env: launcherEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(pidFile);
    expect(refused.stderr).toContain("is not a regular file");
    expect(refused.stdout).not.toContain("Branch daemon spawned");
  }, 30_000);

  test("a daemon leaves a replacement record in place on shutdown", async () => {
    const { daemon } = await startSpawnedDaemon();
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
    expect(readFileSync(logFile, "utf8")).toContain("does not match this process's pid and start token");
  }, 30_000);

  test("a daemon removes its own record on shutdown", async () => {
    const { daemon } = await startSpawnedDaemon();
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
