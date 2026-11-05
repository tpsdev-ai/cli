/**
 * cli#735 — `office kill` re-lists the connections directory after signalling,
 * so a host record created while the kill is running is checked in a later
 * pass. A writer that keeps creating records past the fixed bound makes the
 * command exit non-zero without reporting success, naming the records.
 *
 * Every process tree the tests start is owned by a recorded process group:
 * each root is spawned as a group leader (`detached`) and its children inherit
 * the group, so cleanup can kill a writer and its children together. The
 * record chain is bounded: each host creates one replacement on SIGTERM and
 * the chain depth stops it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Each pass stops the two live records and each host creates one replacement
// before it exits. Two chains bounded at 13 records each make 26 records,
// more than the five passes plus the final listing consume.
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

function killProcessGroups(): void {
  for (const pgid of processGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* the group is already empty */
    }
  }
}

afterEach(
  async () => {
    try {
      killProcessGroups();
      // A host may fork its replacement while the first signal is being
      // delivered; a second pass catches a child that joined the group after it.
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      killProcessGroups();
    } finally {
      processGroups.clear();
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
  killProcessGroups();
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
function runKill(): Promise<KillResult> {
  const child = spawn(process.execPath, [TPS_BIN, "office", "kill"], {
    env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
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

function spawnDetached(command: string, args: string[], stdio: ("ignore" | "pipe")[]): ChildProcess {
  const child = spawn(command, args, { stdio, detached: true });
  if (child.pid === undefined) throw new Error(`${command} has no pid`);
  processGroups.add(child.pid);
  return child;
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
    "a writer that keeps creating records past the bound makes the kill fail and name them",
    async () => {
      const dir = join(home, ".tps", "connections");
      const script = join(home, "record-chain.ts");
      writeFileSync(
        script,
        `
          import { spawn } from "node:child_process";
          import { writeFileSync } from "node:fs";
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
              const next = spawn(process.execPath, [script, dir, marker, String(depth - 1), String(index + 2)], { stdio: "ignore" });
              writeRecord(next.pid as number, index + 2);
            }
            process.exit(0);
          });
          writeFileSync(join(dir, "ready-" + index), "");
          setInterval(() => {}, 1000);
        `,
        "utf8",
      );

      // Two chains; each host writes one replacement record before it exits.
      // The chain depth (12) bounds each at 13 records.
      for (const index of [0, 1]) {
        const host = spawnDetached(
          process.execPath,
          [script, dir, MARKER, String(CHAIN_DEPTH), String(index)],
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
      expect(result.output).toContain(`still appearing after ${MAX_PASSES} passes: `);
      expect(result.output).toContain("Re-run the command, or stop whatever keeps creating them.");
      const named = (result.output.split(`still appearing after ${MAX_PASSES} passes: `)[1] ?? "").split(". Re-run")[0] ?? "";
      expect(named).toMatch(/host-\d+\.json/);
      for (const entry of named.split(", ")) {
        expect(entry.endsWith(".json")).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );
});
