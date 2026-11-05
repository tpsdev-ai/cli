/**
 * cli#735 — host records are re-listed after each signalling pass and again
 * after the branch step, within a bounded number of passes. Records first
 * seen at a pass limit are named, not stopped in that pass; new record paths
 * created after the last listing are not seen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { hostStatePath } from "../src/utils/connection-state.js";
import { serializePidRecord } from "../src/utils/pid-file.js";

const TEST_TIMEOUT = 120_000;
const HOOK_TIMEOUT = 60_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const AGENT_INDEX = resolve(import.meta.dir, "../../agent/src/index.ts");
const MAX_PASSES = 5;
const CHAIN_DEPTH = 12;

const MARKER = `tps735-${randomUUID()}`;

/** Process-group ids (the pid of each detached leader) this file started. */
const processGroups = new Set<number>();

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

/** SIGKILL every tracked process group. A group that no longer exists
 *  (ESRCH) is dropped from tracking; any other error keeps the group tracked
 *  for the next attempt and is returned. */
function killProcessGroups(): string[] {
  const problems: string[] = [];
  for (const pgid of [...processGroups]) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") processGroups.delete(pgid);
      else problems.push(`process group ${pgid}: ${code ?? String(error)}`);
    }
  }
  return problems;
}

afterEach(
  async () => {
    try {
      killProcessGroups();
      // A host may fork its replacement while the first signal is being
      // delivered; a second pass catches a child that joined the group after it.
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const problems = killProcessGroups();
      // Groups that were signalled stay tracked until a later attempt finds
      // them gone; afterAll makes the final attempt and asserts no survivor.
      if (problems.length > 0) throw new Error(`could not signal: ${problems.join("; ")}`);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedRoot === undefined) delete process.env.TPS_ROOT;
      else process.env.TPS_ROOT = savedRoot;
      if (home !== undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
  HOOK_TIMEOUT,
);

/** Live (not zombie) processes whose command line carries this run's marker. */
function markedProcesses(): string[] {
  const ps = spawnSync("ps", ["-A", "-ww", "-o", "pid=,stat=,command="], { encoding: "utf8", timeout: 15_000 });
  if (ps.error || ps.status !== 0) {
    const detail = ps.error?.message ?? `status ${ps.status ?? "null"}`;
    throw new Error(`ps could not list processes (${detail}), so leftovers are unknown`);
  }
  return ps.stdout
    .split("\n")
    .filter((line) => line.includes(MARKER))
    .filter((line) => {
      const stat = line.trim().split(/\s+/)[1] ?? "";
      return !stat.startsWith("Z");
    });
}

afterAll(async () => {
  const problems = killProcessGroups();
  expect(problems).toEqual([]);
  const deadline = Date.now() + 10_000;
  let survivors = markedProcesses();
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    survivors = markedProcesses();
  }
  expect(survivors).toEqual([]);
}, HOOK_TIMEOUT);

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

/** Spawn the real CLI in its own process group and wait for it to be reaped. */
function runKill(extraEnv: Record<string, string> = {}): Promise<KillResult> {
  const child = spawn(process.execPath, [TPS_BIN, "office", "kill"], {
    env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root"), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid === undefined) throw new Error("office kill has no pid");
  processGroups.add(child.pid);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("office kill did not exit within the bound")), TEST_TIMEOUT - 5_000);
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

/** Wait for the kill command to announce its branch-step test pause. */
function waitForPauseReady(dir: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          reject(error);
          return;
        }
      }
      if (names.some((name) => name.startsWith("ready-office-kill-branch-before-decision-"))) {
        resolveWait();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for the branch-step pause in ${dir}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

/** Wait for a pid record at `path` that names a pid other than `notPid`. */
function waitForRecordPidOtherThan(path: string, notPid: number, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      try {
        const pid = Number(JSON.parse(readFileSync(path, "utf8")).pid);
        if (Number.isInteger(pid) && pid > 0 && pid !== notPid) {
          resolveWait(pid);
          return;
        }
      } catch {
        /* not written yet, or caught mid-write */
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for a new pid record at ${path}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function spawnDetached(command: string, args: string[], stdio: ("ignore" | "pipe")[]): ChildProcess {
  const child = spawn(command, args, { stdio, detached: true });
  if (child.pid === undefined) throw new Error(`${command} has no pid`);
  processGroups.add(child.pid);
  return child;
}

describe("office kill re-lists host records", () => {
  test(
    "a first-pass listing failure is reported after the post-branch pass settles",
    async () => {
      const dir = join(home, ".tps", "connections");
      const pauseDir = join(home, "pause");
      mkdirSync(pauseDir);
      mkdirSync(join(home, "tps-root"));
      rmSync(dir, { recursive: true });
      writeFileSync(dir, "not a directory");
      try {
        const resultPromise = runKill({
          TPS_BRANCH_TEST_PAUSE_DIR: pauseDir,
          TPS_BRANCH_TEST_PAUSE_PHASE: "office-kill-branch-before-decision",
        });
        await waitForPauseReady(pauseDir);
        rmSync(dir);
        mkdirSync(dir);
        writeFileSync(join(pauseDir, "go-office-kill-branch-before-decision"), "");
        const result = await resultPromise;
        expect(result.status).toBe(1);
        expect(result.output).toContain(`First host pass: connections directory ${dir} could not be listed (ENOTDIR)`);
        expect(result.output).toContain("records observed before the failure were handled.");
        expect(result.output).toContain("Check the directory and its records, then re-run the command.");
        expect(result.output).not.toContain("Post-branch host pass:");
        expect(result.output).not.toContain("Kill switch engaged");
      } finally {
        killProcessGroups();
      }
    },
    TEST_TIMEOUT,
  );

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
          const marker = process.argv[2];
          const record = ${JSON.stringify(hostBPath)};
          const pidFile = ${JSON.stringify(hostBPidFile)};
          process.on("SIGTERM", () => {
            const child = spawn("sh", ["-c", "trap 'exit 0' TERM; while :; do sleep 0.01; done # " + marker], { stdio: "ignore" });
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

      const hostA = spawnDetached(process.execPath, [script, MARKER], ["ignore", "ignore", "pipe"]);
      await waitForFile(readyFile);
      const pidA = hostA.pid;
      if (pidA === undefined) throw new Error("host-a has no pid");
      const tokenA = processStartToken(pidA);
      if (tokenA === null) throw new Error("no start token for host-a");
      writeFileSync(hostAPath, serializePidRecord(pidA, tokenA), "utf8");

      const result = await runKill();
      await waitForPidExited(pidA);
      const pidB = recordPid(hostBPidFile);

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
    TEST_TIMEOUT,
  );

  test(
    "a host that writes a successor record at the same path is stopped in a later pass",
    async () => {
      const hostAPath = hostStatePath("host-a");
      const seenFile = join(home, "successor-saw-record.txt");
      const script = join(home, "same-path-host.ts");
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { existsSync, readFileSync, writeFileSync } from "node:fs";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const marker = process.argv[2];
          const index = Number(process.argv[3]);
          const record = ${JSON.stringify(hostAPath)};
          const seen = ${JSON.stringify(seenFile)};
          const ready = (at: number) => ${JSON.stringify(home)} + "/same-path-ready-" + at;
          process.on("SIGTERM", () => {
            if (index === 0) {
              const child = spawn(process.execPath, [process.argv[1], marker, "1"], { stdio: "ignore" });
              // Wait for the successor's SIGTERM handler before writing its record.
              const deadline = Date.now() + 5000;
              const wait = new Int32Array(new SharedArrayBuffer(4));
              while (!existsSync(ready(1))) {
                if (Date.now() >= deadline) throw new Error("successor did not become ready");
                Atomics.wait(wait, 0, 0, 5);
              }
              const token = processStartToken(child.pid);
              writeFileSync(record, JSON.stringify({ pid: child.pid, startToken: token }));
            } else {
              let text = "missing";
              try {
                const parsed = JSON.parse(readFileSync(record, "utf8"));
                text = String(parsed.pid) + ":" + String(process.pid);
              } catch {}
              writeFileSync(seen, text);
            }
            process.exit(0);
          });
          writeFileSync(ready(index), "");
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      const hostA = spawnDetached(process.execPath, [script, MARKER, "0"], ["ignore", "ignore", "pipe"]);
      await waitForFile(join(home, "same-path-ready-0"));
      const pidA = hostA.pid;
      if (pidA === undefined) throw new Error("host-a has no pid");
      const tokenA = processStartToken(pidA);
      if (tokenA === null) throw new Error("no start token for host-a");
      writeFileSync(hostAPath, serializePidRecord(pidA, tokenA), "utf8");

      const result = await runKill();
      let seen = "missing";
      try {
        seen = readFileSync(seenFile, "utf8");
      } catch {}


      expect(seen).toMatch(/^\d+:\d+$/);
      const [pidBText, selfBText] = seen.split(":");
      expect(selfBText).toBe(pidBText);
      const pidB = Number(pidBText);
      expect(result.status).toBe(0);
      expect(result.output).not.toContain("could not be stopped");
      expect(result.output).not.toContain("still appearing after");
      const lineB = `Host state record (pid ${pidB}) stopped; record removed: ${hostAPath}.`;
      expect(result.output).toContain(lineB);
      expect(result.output).toContain("Kill switch engaged. Terminated 2 TPS process(es).");
      expect(result.output.indexOf(lineB)).toBeLessThan(result.output.indexOf("Kill switch engaged."));
      expect(existsSync(hostAPath)).toBe(false);
      await waitForPidExited(pidA);
      if (Number.isInteger(pidB)) await waitForPidExited(pidB);
    },
    TEST_TIMEOUT,
  );

  test(
    "a successor record written after the predecessor's record is removed is stopped in the final pass",
    async () => {
      const hostAPath = hostStatePath("host-a");
      const pauseDir = join(home, "pause");
      const successorSeen = join(home, "successor-seen.txt");
      const script = join(home, "removed-then-successor.ts");
      mkdirSync(pauseDir, { recursive: true });
      mkdirSync(join(home, "tps-root"), { recursive: true });
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { existsSync, readdirSync, writeFileSync } from "node:fs";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const marker = process.argv[2];
          const role = process.argv[3];
          const record = ${JSON.stringify(hostAPath)};
          const pauseDir = ${JSON.stringify(pauseDir)};
          const ready = (name) => ${JSON.stringify(home)} + "/ready-" + name;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          const waitFor = (path, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (!existsSync(path)) {
              if (Date.now() >= deadline) throw new Error("timed out waiting for " + path);
              Atomics.wait(wait, 0, 0, 5);
            }
          };
          const waitForAbsent = (path, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (existsSync(path)) {
              if (Date.now() >= deadline) throw new Error("timed out waiting for " + path + " to be removed");
              Atomics.wait(wait, 0, 0, 5);
            }
          };
          const waitForPause = (timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            while (true) {
              let names = [];
              try { names = readdirSync(pauseDir); } catch (error) {
                if (error.code !== "ENOENT") throw error;
              }
              if (names.some((name) => name.startsWith("ready-office-kill-branch-before-decision-"))) return;
              if (Date.now() >= deadline) throw new Error("timed out waiting for the branch-step pause");
              Atomics.wait(wait, 0, 0, 5);
            }
          };
          if (role === "predecessor") {
            process.on("SIGTERM", () => {
              spawn(process.execPath, [process.argv[1], marker, "launcher"], { stdio: "ignore" });
              process.exit(0);
            });
            writeFileSync(ready("predecessor"), "");
            setInterval(() => {}, 1000);
          } else if (role === "launcher") {
            waitForAbsent(record, 30000);
            // Write the successor record while the kill command is held at its
            // branch-step pause, so the record exists before the final pass.
            waitForPause(15000);
            const successor = spawn(process.execPath, [process.argv[1], marker, "successor"], { stdio: "ignore" });
            waitFor(ready("successor"), 10000);
            const token = processStartToken(successor.pid);
            if (token === null) throw new Error("no start token for the successor");
            writeFileSync(record, JSON.stringify({ pid: successor.pid, startToken: token }));
            process.exit(0);
          } else {
            process.on("SIGTERM", () => {
              writeFileSync(${JSON.stringify(successorSeen)}, String(process.pid));
              process.exit(0);
            });
            writeFileSync(ready("successor"), "");
            setInterval(() => {}, 1000);
          }
        `,
        "utf8",
      );

      const hostA = spawnDetached(process.execPath, [script, MARKER, "predecessor"], ["ignore", "ignore", "pipe"]);
      await waitForFile(join(home, "ready-predecessor"));
      const pidA = hostA.pid;
      if (pidA === undefined) throw new Error("host-a has no pid");
      const tokenA = processStartToken(pidA);
      if (tokenA === null) throw new Error("no start token for host-a");
      writeFileSync(hostAPath, serializePidRecord(pidA, tokenA), "utf8");

      const resultPromise = runKill({
        TPS_BRANCH_TEST_PAUSE_DIR: pauseDir,
        TPS_BRANCH_TEST_PAUSE_PHASE: "office-kill-branch-before-decision",
      });
      await waitForPauseReady(pauseDir);
      const pidB = await waitForRecordPidOtherThan(hostAPath, pidA);
      writeFileSync(join(pauseDir, "go-office-kill-branch-before-decision"), "");
      const result = await resultPromise;

      expect(result.status).toBe(0);
      expect(result.output).not.toContain("could not be stopped");
      expect(result.output).not.toContain("still appearing after");
      const lineA = `Host state record (pid ${pidA}) stopped; record removed: ${hostAPath}.`;
      const lineB = `Host state record (pid ${pidB}) stopped; record removed: ${hostAPath}.`;
      expect(result.output).toContain(lineA);
      expect(result.output).toContain(lineB);
      expect(result.output).toContain("Kill switch engaged. Terminated 2 TPS process(es).");
      expect(result.output.indexOf(lineB)).toBeLessThan(result.output.indexOf("Kill switch engaged."));

      expect(pidExited(pidB)).toBe(true);
      expect(existsSync(hostAPath)).toBe(false);
      expect(readFileSync(successorSeen, "utf8")).toBe(String(pidB));
      await waitForPidExited(pidA);
    },
    TEST_TIMEOUT,
  );

  test(
    "a host record created while the branch daemon is stopped is checked in the final pass",
    async () => {
      const hostAPath = hostStatePath("host-a");
      const branchPath = join(home, "tps-root", "branch.pid");
      const hostPidFile = join(home, "branch-successor.pid");
      const readyFile = join(home, "branch.ready");
      const script = join(home, "branch-host.ts");
      mkdirSync(join(home, "tps-root"), { recursive: true });
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { writeFileSync } from "node:fs";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const marker = process.argv[2];
          process.on("SIGTERM", () => {
            const child = spawn("sh", ["-c", "trap 'exit 0' TERM; while :; do sleep 0.01; done # " + marker], { stdio: "ignore" });
            const token = processStartToken(child.pid);
            writeFileSync(${JSON.stringify(hostPidFile)}, String(child.pid));
            writeFileSync(${JSON.stringify(hostAPath)}, JSON.stringify({ pid: child.pid, startToken: token }));
            process.exit(0);
          });
          writeFileSync(${JSON.stringify(readyFile)}, "");
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      const branch = spawnDetached(process.execPath, [script, MARKER], ["ignore", "ignore", "pipe"]);
      await waitForFile(readyFile);
      const pidBranch = branch.pid;
      if (pidBranch === undefined) throw new Error("branch host has no pid");
      const tokenBranch = processStartToken(pidBranch);
      if (tokenBranch === null) throw new Error("no start token for branch host");
      writeFileSync(branchPath, serializePidRecord(pidBranch, tokenBranch), "utf8");

      const result = await runKill();
      const pidHost = recordPid(hostPidFile);

      expect(result.status).toBe(0);
      expect(result.output).not.toContain("could not be stopped");
      const branchLine = `Branch pid file (pid ${pidBranch}) stopped; record removed: ${branchPath}.`;
      const hostLine = `Host state record (pid ${pidHost}) stopped; record removed: ${hostAPath}.`;
      expect(result.output).toContain(branchLine);
      expect(result.output).toContain(hostLine);
      expect(result.output).toContain("Kill switch engaged. Terminated 2 TPS process(es).");
      expect(result.output.indexOf(branchLine)).toBeLessThan(result.output.indexOf(hostLine));
      expect(result.output.indexOf(hostLine)).toBeLessThan(result.output.indexOf("Kill switch engaged."));
      expect(existsSync(branchPath)).toBe(false);
      expect(existsSync(hostAPath)).toBe(false);
      await waitForPidExited(pidBranch);
      await waitForPidExited(pidHost);
    },
    TEST_TIMEOUT,
  );

  test.each([
    ["First host pass", MAX_PASSES],
    ["Post-branch host pass", CHAIN_DEPTH],
  ] as const)(
    "%s bound is reported with the remaining records",
    async (pass, depth) => {
      const dir = join(home, ".tps", "connections");
      const script = join(home, "record-chain.ts");
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { existsSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { processStartToken } from ${JSON.stringify(AGENT_INDEX)};
          const script = process.argv[1];
          const dir = process.argv[2];
          const marker = process.argv[3];
          const depth = Number(process.argv[4]);
          const index = Number(process.argv[5]);
          const writeRecord = (pid: number, at: number) => {
            const token = processStartToken(pid);
            if (token === null) throw new Error("no start token for host " + at);
            writeFileSync(join(dir, "host-" + at + ".json"), JSON.stringify({ pid, startToken: token }));
          };
          process.on("SIGTERM", () => {
            if (depth > 0) {
              const at = index + 2;
              const next = spawn(process.execPath, [script, dir, marker, String(depth - 1), String(at)], { stdio: "ignore" });
              // Wait for the replacement's handler before writing its record.
              const ready = join(dir, "ready-" + at);
              const deadline = Date.now() + 5000;
              const wait = new Int32Array(new SharedArrayBuffer(4));
              while (!existsSync(ready)) {
                if (Date.now() >= deadline) throw new Error("replacement did not become ready");
                Atomics.wait(wait, 0, 0, 5);
              }
              writeRecord(next.pid as number, at);
            }
            process.exit(0);
          });
          writeFileSync(join(dir, "ready-" + index), "");
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      try {
        for (const index of [0, 1]) {
          const host = spawnDetached(
            process.execPath,
            [script, dir, MARKER, String(depth), String(index)],
            ["ignore", "ignore", "pipe"],
          );
          const pid = host.pid;
          if (pid === undefined) throw new Error("chain host has no pid");
          const token = processStartToken(pid);
          if (token === null) throw new Error("no start token for chain host");
          writeFileSync(join(dir, `host-${index}.json`), serializePidRecord(pid, token), "utf8");
        }
        await Promise.all([waitForFile(join(dir, "ready-0")), waitForFile(join(dir, "ready-1"))]);

        const result = await runKill();

        expect(result.status).toBe(1);
        expect(result.output).not.toContain("Kill switch engaged");
        expect(result.output).toContain(`${pass}: host state records were still appearing after ${MAX_PASSES} passes: `);
        expect(result.output).toContain("Re-run the command, or stop whatever keeps creating them.");
        const named = (result.output.split(`still appearing after ${MAX_PASSES} passes: `)[1] ?? "").split(". Re-run")[0] ?? "";
        expect(named).toMatch(/host-\d+\.json/);
        for (const entry of named.split(", ")) {
          expect(entry.endsWith(".json")).toBe(true);
        }
        if (pass === "First host pass") {
          expect(result.output).not.toContain("Post-branch host pass:");
          for (const index of [MAX_PASSES * 2, MAX_PASSES * 2 + 1]) {
            const path = join(dir, `host-${index}.json`);
            expect(named.split(", ")).toContain(path);
            expect(result.output).toContain(`record removed: ${path}.`);
            expect(existsSync(path)).toBe(false);
          }
        }
      } finally {
        killProcessGroups();
      }
    },
    TEST_TIMEOUT,
  );
});
