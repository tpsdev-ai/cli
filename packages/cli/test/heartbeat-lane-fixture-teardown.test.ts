import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/heartbeat-lane-terminated.mjs", import.meta.url));
const OWN_EXIT_FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/heartbeat-lane-teardown-own-exit.mjs", import.meta.url),
);
const WAIT_MS = 10_000;
const POLL_MS = 25;

async function waitFor<T>(read: () => T | Promise<T | null> | null, description: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Fields 3 and 5 of a Linux `/proc/<pid>/stat` line. Field 2 (comm) may
 *  contain spaces and parentheses, so both follow the space after the last
 *  `)`. Null when the pid has no entry; other read errors are rethrown. */
function procStat(pid: number): { state: string; pgrp: number } | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  if (!state || !Number.isInteger(pgrp)) throw new Error(`unreadable /proc/${pid}/stat`);
  return { state, pgrp };
}

/** Live (non-zombie) members of the process group on Linux, or null when
 *  `/proc` is unavailable. A member in state `Z` has exited but still answers
 *  `kill(-pgid, 0)` until its parent reaps it, and a container's PID 1 need
 *  not reap. */
function procGroupAlive(pid: number): boolean | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return entries.some((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    const info = procStat(Number(entry));
    return info !== null && info.pgrp === pid && info.state !== "Z";
  });
}

function pidAlive(pid: number): boolean {
  if (process.platform === "linux") {
    const info = procStat(pid);
    if (info) return info.state !== "Z";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === "linux") {
    const alive = procGroupAlive(pid);
    if (alive !== null) return alive;
  }
  return groupExists(pid);
}

/** SIGKILL the recorded group while it still exists: `kill(-pgid, 0)`
 *  succeeding means a member (zombie included) still holds the number. */
function killRecordedGroup(pid: number): void {
  if (!groupExists(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function stopFixture(fixture: ChildProcess): Promise<void> {
  if (fixture.exitCode !== null || fixture.signalCode !== null) return;
  fixture.kill("SIGKILL");
  await once(fixture, "exit");
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let answered = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("data", (chunk) => {
      answered += chunk;
    });
    socket.on("end", () => resolve(answered === "ready"));
    socket.on("error", () => resolve(false));
  });
}

/** Signals the teardown sends to the recorded group, read from the fixture's
 *  recorded `process.kill` log. Signal 0 is a liveness probe, not a signal. */
function signalsSentToGroup(log: string, pgid: number): string[] {
  return log
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([target, signal]) => Number(target) === -pgid && signal !== "0" && signal !== "")
    .map(([, signal]) => signal);
}

async function terminatedFixture(signal: NodeJS.Signals, expectedStatus: number) {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-terminated-"));
  const fixture = spawn(process.env.NODE_BIN ?? "node", [FIXTURE], {
    env: { ...process.env, TEARDOWN_DIR: root },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let gatewayPid: number | null = null;
  try {
    gatewayPid = Number(await waitFor(() => readText(join(root, "gateway.pid")), "the gateway pid"));
    const gatewayChildPid = Number(await waitFor(() => readText(join(root, "gateway-child.pid")), "the gateway child pid"));
    const port = Number(await waitFor(() => readText(join(root, "gateway.port")), "the gateway port"));
    await waitFor(() => probe(port), "the gateway to answer a readiness probe");
    expect(pidAlive(gatewayPid)).toBe(true);
    expect(pidAlive(gatewayChildPid)).toBe(true);

    const exited = once(fixture, "exit");
    fixture.kill(signal);
    const [code, signalName] = (await exited) as [number | null, string | null];

    await waitFor(() => !groupAlive(gatewayPid as number), "the gateway process group to exit");
    expect(pidAlive(gatewayPid)).toBe(false);
    expect(pidAlive(gatewayChildPid)).toBe(false);
    expect(signalName).toBeNull();
    expect(code).toBe(expectedStatus);
  } finally {
    await stopFixture(fixture);
    if (gatewayPid !== null) killRecordedGroup(gatewayPid);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a heartbeat-lane fixture stops its detached stub gateway when terminated", () => {
  test("SIGTERM stops the gateway's process group and re-exits with 143", async () => {
    await terminatedFixture("SIGTERM", 143);
  }, 30_000);

  test("SIGINT stops the gateway's process group and re-exits with 130", async () => {
    await terminatedFixture("SIGINT", 130);
  }, 30_000);
});

describe("a heartbeat-lane fixture checks the group before signalling", () => {
  test("the own-exit fixture records no group signals and removes teardown handlers", async () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-own-exit-"));
    const fixture = spawn(process.env.NODE_BIN ?? "node", [OWN_EXIT_FIXTURE], {
      env: { ...process.env, TEARDOWN_DIR: root },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let gatewayPid: number | null = null;
    try {
      gatewayPid = Number(await waitFor(() => readText(join(root, "gateway.pid")), "the gateway pid"));
      await waitFor(() => readText(join(root, "gateway-exited")), "the gateway to exit");
      await waitFor(() => !groupAlive(gatewayPid as number), "the gateway group to exit");

      const exited = once(fixture, "exit");
      fixture.kill("SIGTERM");
      const [code, signalName] = (await exited) as [number | null, string | null];

      expect(signalName).toBeNull();
      expect(code).toBe(143);
      expect(signalsSentToGroup(readText(join(root, "kill.log")) ?? "", gatewayPid)).toEqual([]);
      expect(readListeners(root)).toEqual({ SIGTERM: 0, SIGINT: 0, exit: 1 });
    } finally {
      await stopFixture(fixture);
      if (gatewayPid !== null) killRecordedGroup(gatewayPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a normal exit after the group is gone leaves the status unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-own-exit-"));
    const fixture = spawn(process.env.NODE_BIN ?? "node", [OWN_EXIT_FIXTURE], {
      env: { ...process.env, TEARDOWN_DIR: root, TEARDOWN_EXIT: "normal" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let gatewayPid: number | null = null;
    try {
      gatewayPid = Number(await waitFor(() => readText(join(root, "gateway.pid")), "the gateway pid"));
      await waitFor(() => readText(join(root, "gateway-exited")), "the gateway to exit");
      const exited =
        fixture.exitCode !== null || fixture.signalCode !== null
          ? Promise.resolve([fixture.exitCode, fixture.signalCode] as const)
          : once(fixture, "exit");
      const [code, signalName] = (await exited) as [number | null, string | null];

      expect(signalName).toBeNull();
      expect(code).toBe(0);
      expect(signalsSentToGroup(readText(join(root, "kill.log")) ?? "", gatewayPid)).toEqual([]);
      expect(readListeners(root)).toEqual({ SIGTERM: 0, SIGINT: 0, exit: 1 });
    } finally {
      await stopFixture(fixture);
      if (gatewayPid !== null) killRecordedGroup(gatewayPid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function readListeners(root: string): unknown {
  return JSON.parse(readText(join(root, "listeners.json")) ?? "null");
}

async function unconfirmedFixture(exit: "signal" | "normal") {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-unconfirmed-"));
  const fixture = spawn(process.env.NODE_BIN ?? "node", [FIXTURE], {
    env: {
      ...process.env,
      TEARDOWN_DIR: root,
      TEARDOWN_STUB_SURVIVOR: "1",
      ...(exit === "normal" ? { TEARDOWN_EXIT: "normal" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  fixture.stderr?.setEncoding("utf8");
  fixture.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let gatewayPid: number | null = null;
  try {
    gatewayPid = Number(await waitFor(() => readText(join(root, "gateway.pid")), "the gateway pid"));

    const exited = once(fixture, "exit");
    if (exit === "normal") fixture.stdin?.write("exit\n");
    else fixture.kill("SIGTERM");
    const [code, signalName] = (await exited) as [number | null, string | null];

    expect(signalName).toBeNull();
    expect(code).toBe(1);
    await waitFor(
      () => (stderr.includes("could not be confirmed") ? true : null),
      "the unconfirmed-cleanup line",
    );
    expect(stderr).toContain(`cleanup of process group ${gatewayPid} could not be confirmed: ${gatewayPid}`);
  } finally {
    await stopFixture(fixture);
    if (gatewayPid !== null) killRecordedGroup(gatewayPid);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a heartbeat-lane fixture reports an unconfirmed cleanup", () => {
  test("an unconfirmed cleanup on a normal exit exits 1 and names the pgid and the survivor", async () => {
    await unconfirmedFixture("normal");
  }, 30_000);

  test("an unconfirmed cleanup after a signal exits 1 and names the pgid and the survivor", async () => {
    await unconfirmedFixture("signal");
  }, 30_000);
});
