/**
 * cli#693 — the shared live-process helper must not outlive the test process
 * that started it when teardown is skipped (a killed test process, a timed-out
 * lane). The helper watches stdin close and a changed ppid; both are exercised.
 */
import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIVE_PROCESS_SCRIPT, spawnLiveProcess } from "./helpers/live-process.js";

/**
 * Five seconds: stdin close is immediate on a killed parent, the ppid poll runs
 * every 250 ms, and the margin covers a loaded CI runner. A helper that survives
 * its parent stays alive indefinitely, so any finite bound separates the cases.
 */
const EXIT_BOUND_MS = 5_000;

/** Whether the pid still exists. A Linux zombie counts as exited. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const nameEnd = stat.lastIndexOf(")");
      return stat.slice(nameEnd + 2, nameEnd + 3) !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function waitForExit(pid: number, timeoutMs = EXIT_BOUND_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isRunning(pid);
}

function kill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitForParentExit(parent: ChildProcess): Promise<void> {
  if (parent.exitCode !== null || parent.signalCode !== null) return;
  await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
}

/** Read the helper pid the short-lived parent prints on its first stdout line. */
async function readPid(parent: ChildProcess): Promise<number> {
  const stdout = parent.stdout;
  if (!stdout) throw new Error("parent has no stdout pipe");
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not report the helper pid")), EXIT_BOUND_MS);
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split("\n")[0];
      if (!line) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
  });
}

function writeParentScript(root: string, helperUrl: string, stdio: string): string {
  const path = join(root, `parent-${stdio}.ts`);
  writeFileSync(path, `
import { spawn } from "node:child_process";
import { LIVE_PROCESS_SCRIPT, spawnLiveProcess } from ${JSON.stringify(helperUrl)};
const child = ${stdio === "inherit" ? `spawn(process.execPath, ["-e", LIVE_PROCESS_SCRIPT], { stdio: ["inherit", "ignore", "ignore"] })` : "spawnLiveProcess()"};
console.log(String(child.pid));
setInterval(function keepAlive() {}, 1000);
`);
  return path;
}

test("the helper exits after its parent is SIGKILLed without teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-helper-"));
  const helperUrl = pathToFileURL(join(import.meta.dir, "helpers/live-process.ts")).href;
  const parent = spawn(process.execPath, [writeParentScript(root, helperUrl, "pipe")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let childPid: number | undefined;
  try {
    childPid = await readPid(parent);
    expect(childPid).toBeGreaterThan(0);
    expect(isRunning(childPid)).toBe(true);
    parent.kill("SIGKILL");
    await waitForParentExit(parent);
    expect(await waitForExit(childPid)).toBe(true);
  } finally {
    kill(childPid);
    kill(parent.pid);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("the helper exits when its parent dies and the stdin pipe stays open", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-ppid-"));
  const helperUrl = pathToFileURL(join(import.meta.dir, "helpers/live-process.ts")).href;
  // The parent inherits the test's stdin pipe and passes it to the helper, so
  // the pipe's write end stays open in this process after the parent dies.
  const parent = spawn(process.execPath, [writeParentScript(root, helperUrl, "inherit")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let childPid: number | undefined;
  try {
    childPid = await readPid(parent);
    expect(childPid).toBeGreaterThan(0);
    expect(isRunning(childPid)).toBe(true);
    parent.kill("SIGKILL");
    await waitForParentExit(parent);
    expect(await waitForExit(childPid)).toBe(true);
  } finally {
    kill(childPid);
    kill(parent.pid);
    parent.stdin?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a normal teardown still stops the helper", async () => {
  const child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  expect(isRunning(pid)).toBe(true);
  child.kill("SIGKILL");
  await waitForParentExit(child);
  expect(isRunning(pid)).toBe(false);
}, 15_000);
