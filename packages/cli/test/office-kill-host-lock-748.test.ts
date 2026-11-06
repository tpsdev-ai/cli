/**
 * cli#748 — one shared lock per host state record. The host connection writer
 * and the connector's shutdown take it, and `office kill` holds it across its
 * final read and removal, so the host connection writer cannot replace and
 * lose a successor record in the window between the two.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import {
  clearHostState,
  hostStateLockRoot,
  hostStatePath,
  readHostState,
  writeHostState,
  type HostConnectionState,
} from "../src/utils/connection-state.js";
import { mailLockPath } from "../src/utils/mail-lock.js";

const TIMEOUT = 60_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const AGENT_INDEX = resolve(import.meta.dir, "../../agent/src/index.ts");
const CONNECTION_STATE = resolve(import.meta.dir, "../src/utils/connection-state.ts");

const children: Bun.Subprocess[] = [];
const processes: ChildProcess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/** A pid that was live and is now reaped, or null when it cannot be found. */
function reapedPid(): number | null {
  const child = spawnSync("true", []);
  if (child.pid === undefined) return null;
  return pidState(child.pid) === "gone" ? child.pid : null;
}

function hostState(branch: string, pid: number, startToken: string | null): HostConnectionState {
  return {
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
    startToken,
  };
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function waitForPrefix(dir: string, prefix: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (names.some((name) => name.startsWith(prefix))) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${prefix} in ${dir}`);
    await Bun.sleep(5);
  }
}

interface KillRun {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function runKill(env: NodeJS.ProcessEnv): KillRun {
  const child = spawn(process.execPath, [TPS_BIN, "office", "kill"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("office kill did not exit within the bound")), 30_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return { child, output: () => output, exited };
}

let home: string;
let savedHome: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedRoot = process.env.TPS_ROOT;
  home = mkdtempSync(join(tmpdir(), "tps-office-kill-748-"));
  process.env.HOME = home;
  delete process.env.TPS_ROOT;
  mkdirSync(join(home, ".tps", "connections"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.TPS_ROOT;
  else process.env.TPS_ROOT = savedRoot;
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const child of processes.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

describe("host state record lock", () => {
  test(
    "a successor write attempted between office kill's final read and removal is kept and reported",
    async () => {
      const root = join(home, "tps-root");
      mkdirSync(root, { recursive: true });
      const pauseDir = join(home, "pause");
      mkdirSync(pauseDir);

      const predecessor = spawnChild();
      const path = hostStatePath("host-a");
      writeHostState(hostState("host-a", predecessor.pid, childToken(predecessor.pid)));

      const started = join(home, "writer-started");
      const written = join(home, "writer-written");
      const writerScript = join(home, "successor-writer.ts");
      writeFileSync(
        writerScript,
        `
          import { writeFileSync } from "node:fs";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          import { writeHostState } from ${JSON.stringify(CONNECTION_STATE)};
          const [started, written, branch] = process.argv.slice(2);
          writeFileSync(started, "");
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
            pid: process.pid,
            startToken: processStartToken(process.pid),
          });
          writeFileSync(written, "");
          process.on("SIGTERM", () => {});
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        TPS_ROOT: root,
        TPS_TEST_ROOT: root,
        TPS_BRANCH_TEST_PAUSE_DIR: pauseDir,
        TPS_OFFICE_KILL_HOST_PAUSE: "1",
      };
      delete env.TPS_BRANCH_TEST_PAUSE_PHASE;

      const kill = runKill(env);
      let writer: Bun.Subprocess | undefined;
      let goHostSent = false;
      let goBranchSent = false;
      let status: number | null = null;
      const goHost = join(pauseDir, "go-office-kill-host-before-removal");
      const goBranch = join(pauseDir, "go-office-kill-branch-before-decision");
      try {
        await waitForPrefix(pauseDir, "ready-office-kill-host-before-removal-");
        writer = Bun.spawn([process.execPath, writerScript, started, written, "host-a"], {
          env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        await waitForPath(started, 5_000);

        // Office kill holds the record lock between its final read and the
        // removal, so the host connection writer cannot replace the record in
        // that window.
        await Bun.sleep(250);
        expect(existsSync(written)).toBe(false);

        writeFileSync(goHost, "");
        goHostSent = true;
        // The lock is released by the removal; the successor's write lands
        // after it, so the record that remains names the successor.
        await waitForPath(written, 10_000);
        await waitForPrefix(pauseDir, "ready-office-kill-branch-before-decision-");
        writeFileSync(goBranch, "");
        goBranchSent = true;
        status = await kill.exited;

        const writerPid = writer.pid;
        const output = kill.output();
        expect(status).toBe(1);
        expect(existsSync(path)).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(writerPid);
        expect(output).toContain(`Host state record (pid ${predecessor.pid}) stopped; record removed: ${path}.`);
        expect(output).toContain(`Host state record could not be stopped (pid ${writerPid}); record kept at ${path}.`);
        expect(output).not.toContain(`(pid ${writerPid}) stopped`);
      } finally {
        if (!goHostSent) {
          try {
            writeFileSync(goHost, "");
          } catch {
            /* the pause directory is gone */
          }
        }
        if (!goBranchSent) {
          try {
            writeFileSync(goBranch, "");
          } catch {
            /* the pause directory is gone */
          }
        }
        if (writer !== undefined) {
          try {
            writer.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          await writer.exited.catch(() => {});
        }
        await kill.exited.catch(() => {});
      }
    },
    TIMEOUT,
  );

  test(
    "the connector's shutdown leaves a record that names another process",
    () => {
      const other = spawnChild();
      const path = hostStatePath("host-a");
      writeHostState(hostState("host-a", other.pid, childToken(other.pid)));

      clearHostState("host-a");

      const current = readHostState("host-a");
      expect(current?.pid).toBe(other.pid);
      expect(readFileSync(path, "utf8")).toContain(String(other.pid));
    },
    TIMEOUT,
  );

  test(
    "the connector's shutdown leaves a record whose start token names another process",
    () => {
      const token = childToken(process.pid);
      const foreign = token.startsWith("ps:") ? "ps:Thu Jan 1 00:00:00 1970" : "proc:1";
      const path = hostStatePath("host-a");
      writeHostState(hostState("host-a", process.pid, foreign));

      clearHostState("host-a");

      expect(readHostState("host-a")?.startToken).toBe(foreign);
      expect(existsSync(path)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "the connector's shutdown removes the record that names its own process",
    () => {
      writeHostState(hostState("host-a", process.pid, childToken(process.pid)));

      clearHostState("host-a");

      expect(readHostState("host-a")).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a stale lock from a dead holder is reclaimed",
    () => {
      const dead = reapedPid();
      if (dead === null) throw new Error("no reaped pid was available; rerun the test");
      const path = hostStatePath("host-a");
      const lockRoot = hostStateLockRoot(path);
      const lockDir = mailLockPath(lockRoot);
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: dead, startToken: null }));

      writeHostState(hostState("host-a", process.pid, childToken(process.pid)));

      expect(readHostState("host-a")?.pid).toBe(process.pid);
      expect(existsSync(lockDir)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a lock held by a live owner is refused after the bound with a remedy",
    () => {
      const path = hostStatePath("host-a");
      const lockRoot = hostStateLockRoot(path);
      const lockDir = mailLockPath(lockRoot);
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, startToken: processStartToken(process.pid) }),
      );
      try {
        expect(() => writeHostState(hostState("host-a", process.pid, childToken(process.pid)))).toThrow(
          `Host state record lock ${lockDir} could not be acquired within 5000 ms; refusing to write the host state record.`,
        );
        expect(readHostState("host-a")).toBeNull();
      } finally {
        rmSync(lockRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
