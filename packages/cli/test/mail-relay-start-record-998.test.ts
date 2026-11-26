/**
 * cli#998 / cli#992 — the relay pid record across start, the daemon's write and
 * the daemon's exit. A start refuses a record it cannot parse, replaces a stale
 * one, and claims the path exclusively; the daemon writes atomically and removes
 * the record only while it still holds its own bytes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { readPidFile } from "../src/utils/pid-file.js";
import { readRelayPidFile, relayWriteTestHooks, writeRelayPidRecordAtomically } from "../src/utils/mail-relay.js";
import { patchShared } from "./helpers/patch-shared.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const CASE_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 20_000;
const WAIT_DEADLINE_MS = 10_000;

let home: string;
let relayPid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

function spawnSleep(seconds = "60"): Bun.Subprocess {
  const child = Bun.spawn(["sleep", seconds], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${WAIT_DEADLINE_MS} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (pidState(pid) !== "gone") {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for pid ${pid} to exit`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The pids of relay daemons whose argv carries this test's HOME. */
function relayDaemonPids(): number[] {
  const out = spawnSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .filter((line) => line.includes(home) && line.includes("relay") && line.includes("_run"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid));
}

function runCli(args: string[], timeout = CLI_TIMEOUT_MS): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TPS_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function runCliAsync(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, TPS_BIN, ...args], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, CLI_TIMEOUT_MS);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Kill a relay recorded at the path, by that recorded pid. */
function stopRecordedRelay(): void {
  try {
    const state = readPidFile(relayPid);
    if (state.kind === "running" || state.kind === "unverified" || state.kind === "stale") {
      killPid(state.pid);
    }
  } catch {
    /* no record */
  }
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-relay-start-998-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps", "mail"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
});

afterEach(() => {
  stopRecordedRelay();
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("relay start and the pid record", () => {
  test(
    "(a) a torn record naming a live process is kept, refused and spawns nothing",
    () => {
      const child = spawnSleep();
      const torn = `{"pid":${child.pid},"startToken":"proc:`;
      writeFileSync(relayPid, torn);
      const before = readFileSync(relayPid);

      const result = runCli(["mail", "relay", "start"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/is invalid/);
      expect(result.stderr).toMatch(/by hand/);
      expect(readFileSync(relayPid).equals(before)).toBe(true);
      expect(relayDaemonPids()).toEqual([]);
      expect(pidState(child.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(b) a stale record is replaced and a relay is launched",
    async () => {
      const dead = spawnSleep("5");
      const deadPid = dead.pid;
      const token = processStartToken(deadPid);
      killPid(deadPid);
      await dead.exited;
      expect(pidState(deadPid)).toBe("gone");
      writeFileSync(relayPid, record(deadPid, token));

      const result = runCli(["mail", "relay", "start"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Mail relay started: pid=");
      const state = readPidFile(relayPid);
      expect(["running", "unverified"]).toContain(state.kind);
      if (state.kind !== "running" && state.kind !== "unverified") throw new Error("no relay record");
      expect(state.pid).not.toBe(deadPid);
      expect(pidState(state.pid)).toBe("alive");
      process.kill(state.pid, "SIGTERM");
      await waitGone(state.pid);
      await waitUntil(() => !existsSync(relayPid), "the daemon to remove its record");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(c) two concurrent starts launch one relay and the loser exits non-zero",
    async () => {
      const [first, second] = await Promise.all([
        runCliAsync(["mail", "relay", "start"]),
        runCliAsync(["mail", "relay", "start"]),
      ]);

      expect([first.status, second.status].filter((status) => status === 0)).toHaveLength(1);
      const loser = first.status === 0 ? second : first;
      expect(loser.status).not.toBe(0);
      expect(loser.stderr).toContain(relayPid);
      expect(relayDaemonPids()).toHaveLength(1);

      const state = readPidFile(relayPid);
      expect(["running", "unverified"]).toContain(state.kind);
      if (state.kind !== "running" && state.kind !== "unverified") throw new Error("no relay record");
      expect(pidState(state.pid)).toBe("alive");
      process.kill(state.pid, "SIGTERM");
      await waitGone(state.pid);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(d) a real daemon keeps a new record written after its stop signal",
    async () => {
      const daemon = Bun.spawn([process.execPath, TPS_BIN, "mail", "relay", "_run", join(home, ".tps", "mail")], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "ignore", "ignore"],
      });
      children.push(daemon);
      await waitUntil(() => {
        const state = readPidFile(relayPid);
        return (state.kind === "running" || state.kind === "unverified") && state.pid === daemon.pid;
      }, "the daemon's own record");

      const replacement = spawnSleep();
      const newRecord = record(replacement.pid, processStartToken(replacement.pid));
      writeFileSync(relayPid, newRecord);
      process.kill(daemon.pid, "SIGTERM");
      await daemon.exited;

      expect(existsSync(relayPid)).toBe(true);
      expect(readFileSync(relayPid, "utf8")).toBe(newRecord);
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "(e) the daemon's write uses a same-directory temporary and a rename",
    () => {
      const oldRecord = record(11111, "proc:1");
      const newRecord = record(22222, "proc:2");
      writeFileSync(relayPid, oldRecord);
      let tempPath = "";
      let duringWrite = "";
      const restore = patchShared(relayWriteTestHooks, "afterTempWrite", (tmp, path) => {
        tempPath = tmp;
        expect(dirname(tmp)).toBe(dirname(path));
        expect(tmp).not.toBe(path);
        expect(readFileSync(tmp, "utf8")).toBe(newRecord);
        duringWrite = readFileSync(path, "utf8");
      });
      try {
        writeRelayPidRecordAtomically(relayPid, newRecord);
      } finally {
        restore();
      }

      expect(tempPath).not.toBe("");
      expect(duringWrite).toBe(oldRecord);
      expect(readFileSync(relayPid, "utf8")).toBe(newRecord);
      expect(readdirSync(dirname(relayPid)).filter((name) => name.includes(".relay.pid.tmp."))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  test("relay status reports a live claim as a start in progress", () => {
    const starter = spawnSleep();
    writeFileSync(
      relayPid,
      `${JSON.stringify({ pid: starter.pid, startToken: processStartToken(starter.pid), relayClaim: true })}\n`,
    );
    expect(readRelayPidFile().kind).toBe("claim");
    const result = runCli(["mail", "relay", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/start in progress/i);
    expect(result.stdout).not.toMatch(/invalid/i);
  }, CASE_TIMEOUT_MS);

  test(
    "relay stop refuses a live claim and signals nothing",
    () => {
      const starter = spawnSleep();
      const claim = `${JSON.stringify({ pid: starter.pid, startToken: processStartToken(starter.pid), relayClaim: true })}\n`;
      writeFileSync(relayPid, claim);

      const result = runCli(["mail", "relay", "stop"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/start is in progress/);
      expect(readFileSync(relayPid, "utf8")).toBe(claim);
      expect(pidState(starter.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );
});
