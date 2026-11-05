/**
 * cli#735 — `office kill` re-lists the connections directory after signalling,
 * so a host record created while the kill is running is checked in a later
 * pass. A writer that keeps creating records past the fixed bound makes the
 * command exit non-zero without reporting success, naming the records.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { hostStatePath } from "../src/utils/connection-state.js";
import { serializePidRecord } from "../src/utils/pid-file.js";

const TIMEOUT = 40_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const AGENT_INDEX = resolve(import.meta.dir, "../../agent/src/index.ts");
const MAX_PASSES = 5;

const children: ChildProcess[] = [];
const spawnedPids: number[] = [];

let home: string;
let savedHome: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedRoot = process.env.TPS_ROOT;
  home = mkdtempSync(join(tmpdir(), "tps-office-kill-735-"));
  process.env.HOME = home;
  delete process.env.TPS_ROOT;
  mkdirSync(join(home, ".tps", "connections"), { recursive: true });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const pid of spawnedPids.splice(0)) {
    if (pidState(pid) !== "alive") continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.TPS_ROOT;
  else process.env.TPS_ROOT = savedRoot;
  rmSync(home, { recursive: true, force: true });
});

function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (existsSync(path)) {
        resolveWait();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
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

async function waitForPidExited(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pidExited(pid)) {
    if (Date.now() >= deadline) throw new Error(`pid ${pid} did not exit within the bound`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

interface KillResult {
  status: number | null;
  output: string;
}

/** Spawn the real CLI and wait for the child to be reaped (macOS keeps pids
 *  alive while a zombie is not collected by the parent). */
function runKill(): Promise<KillResult> {
  const child = spawn(process.execPath, [TPS_BIN, "office", "kill"], {
    env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("office kill did not exit within the bound")), TIMEOUT - 5_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit({ status: code, output });
    });
  });
}

function recordPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`no pid in ${path}`);
  return pid;
}

describe("office kill re-lists host records", () => {
  test(
    "a host that starts a new host on SIGTERM is checked in a later pass",
    async () => {
      const hostAPath = hostStatePath("host-a");
      const hostBPath = hostStatePath("host-b");
      const hostBPidFile = join(home, "host-b.pid");
      const readyFile = join(home, "host-a.ready");
      const script = join(home, "host-a.ts");
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { writeFileSync } from "node:fs";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const record = ${JSON.stringify(hostBPath)};
          const pidFile = ${JSON.stringify(hostBPidFile)};
          process.on("SIGTERM", () => {
            const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
            child.unref();
            const token = processStartToken(child.pid);
            writeFileSync(pidFile, String(child.pid));
            writeFileSync(record, JSON.stringify({ pid: child.pid, startToken: token }));
            process.exit(0);
          });
          writeFileSync(${JSON.stringify(readyFile)}, "");
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      const hostA = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
      children.push(hostA);
      await waitForFile(readyFile);
      const pidA = hostA.pid;
      if (pidA === undefined) throw new Error("host-a has no pid");
      const tokenA = processStartToken(pidA);
      if (tokenA === null) throw new Error("no start token for host-a");
      writeFileSync(hostAPath, serializePidRecord(pidA, tokenA), "utf8");

      const result = await runKill();
      await waitForPidExited(pidA);
      const pidB = recordPid(hostBPidFile);
      spawnedPids.push(pidB);

      expect(result.status).toBe(0);
      expect(result.output).not.toContain("could not be stopped");
      expect(result.output).not.toContain("still appearing after");
      const lineA = `Host state record (pid ${pidA}) stopped; record removed: ${hostAPath}.`;
      const lineB = `Host state record (pid ${pidB}) stopped; record removed: ${hostBPath}.`;
      expect(result.output).toContain(lineA);
      expect(result.output).toContain(lineB);
      expect(result.output).toContain(`Kill switch engaged. Terminated 2 TPS process(es).`);
      expect(result.output.indexOf(lineA)).toBeLessThan(result.output.indexOf(lineB));
      expect(result.output.indexOf(lineB)).toBeLessThan(result.output.indexOf("Kill switch engaged."));
      expect(existsSync(hostAPath)).toBe(false);
      expect(existsSync(hostBPath)).toBe(false);
      await waitForPidExited(pidB);
      expect(pidExited(pidA)).toBe(true);
      expect(pidExited(pidB)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a writer that keeps creating records past the bound makes the kill fail and name them",
    async () => {
      const writerPidFile = join(home, "writer-pids.txt");
      const readyFile = join(home, "writer.ready");
      const script = join(home, "record-writer.ts");
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { appendFileSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const dir = process.argv[2];
          const pidFile = process.argv[3];
          const ready = process.argv[4];
          const childCommand = "trap 'sleep 0.05; exit 0' TERM; while :; do sleep 0.01; done";
          let index = 0;
          const writeRecord = () => {
            const child = spawn("sh", ["-c", childCommand], { stdio: "ignore" });
            const token = processStartToken(child.pid);
            if (token === null) throw new Error("no start token for writer child");
            writeFileSync(join(dir, "host-" + index + ".json"), JSON.stringify({ pid: child.pid, startToken: token }));
            appendFileSync(pidFile, String(child.pid) + "\\n");
            index++;
          };
          writeRecord();
          writeRecord();
          writeFileSync(ready, "");
          setInterval(() => {
            if (index >= 500) process.exit(0);
            writeRecord();
          }, 80);
        `,
        "utf8",
      );

      const writer = spawn(process.execPath, [
        script,
        join(home, ".tps", "connections"),
        writerPidFile,
        readyFile,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      children.push(writer);
      await waitForFile(readyFile);

      const result = await runKill();

      const created = readFileSync(writerPidFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(Number);
      spawnedPids.push(...created);

      expect(result.status).toBe(1);
      expect(result.output).not.toContain("Kill switch engaged");
      expect(result.output).toContain(`still appearing after ${MAX_PASSES} passes: `);
      expect(result.output).toContain("Re-run the command, or stop whatever keeps creating them.");
      const named = (result.output.split(`still appearing after ${MAX_PASSES} passes: `)[1] ?? "").split(". Re-run")[0] ?? "";
      expect(named).toMatch(/host-\d+\.json/);
      for (const entry of named.split(", ")) {
        expect(entry.endsWith(".json")).toBe(true);
      }
    },
    TIMEOUT,
  );
});
