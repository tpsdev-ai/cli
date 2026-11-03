/**
 * cli#693 — the shared live-process helper must not outlive the test process
 * that started it when teardown is skipped (a killed test process, a timed-out
 * lane). The helper watches stdin close and its spawner's pid.
 *
 * The fixture processes in this file watch the pid that started them the same
 * way, and every FIFO open is asynchronous, so the watch keeps running while an
 * open waits. A hard kill can still leave the mkdtemp scratch directory behind.
 */
import { expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIVE_PROCESS_READY, spawnLiveProcess } from "./helpers/live-process.js";

/** Operational test allowance for a child to act on its owner's death. */
const EXIT_BOUND_MS = 15_000;

/**
 * Exits when the pid that spawned the fixture is gone, with the helper's
 * ESRCH/EPERM handling. The script that includes it reads the pid from argv[2].
 */
const WATCH_OWNER = `
const ownerPid = Number(process.argv[2]);
if (!Number.isInteger(ownerPid) || ownerPid <= 0) process.exit(2);
setInterval(function watchOwner() {
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "EPERM") process.exit(0);
  }
}, 250);
`;

/** Opens the FIFO for writing and holds it open while the fixture lives. */
const HOLDER_SCRIPT = `
const { open } = require("node:fs/promises");
${WATCH_OWNER}
if (process.argv[3]) require("node:fs").writeFileSync(process.argv[3], "");
open(process.argv[1], "w").then(function onOpen(handle) {
  globalThis.fifo = handle;
  setInterval(function keepAlive() {}, 1000);
}, function onError() { process.exit(3); });
`;

const HELPER_URL = pathToFileURL(join(import.meta.dir, "helpers/live-process.ts")).href;

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

/** Read the helper pid the parent prints on its stdout. */
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

/** Read the pid a parent that dies immediately writes before killing itself. */
async function readPidFile(path: string): Promise<number> {
  const deadline = Date.now() + EXIT_BOUND_MS;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return Number(text);
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("parent did not write the helper pid");
}

type ParentMode = "pipe" | "fifo-ready" | "fifo-immediate";

/**
 * A short-lived intermediate parent: it starts the helper and reports its pid.
 * "fifo-ready" reports once the helper prints LIVE_PROCESS_READY; "fifo-immediate"
 * writes the pid and SIGKILLs itself immediately after the spawn. It watches the
 * pid passed in argv[2], and its FIFO open is asynchronous like the holder's.
 */
function writeParentScript(root: string, mode: ParentMode): string {
  const fifo = join(root, "stdin.fifo");
  const marker = join(root, "helper.out");
  const pidFile = join(root, "helper.pid");
  const path = join(root, `parent-${mode}.ts`);
  writeFileSync(
    path,
    `
import { open } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { LIVE_PROCESS_READY, spawnLiveProcess } from ${JSON.stringify(HELPER_URL)};

${WATCH_OWNER}
const mode = ${JSON.stringify(mode)};
const handles = [];

async function startWithFifo() {
  const stdin = await open(${JSON.stringify(fifo)}, "r");
  handles.push(stdin);
  const stdout = mode === "fifo-immediate" ? await open(${JSON.stringify(marker)}, "w") : "pipe";
  if (typeof stdout === "string" && stdout === "pipe") return spawnLiveProcess({ stdin: stdin.fd, stdout });
  handles.push(stdout);
  return spawnLiveProcess({ stdin: stdin.fd, stdout: stdout.fd });
}

const child = mode === "pipe" ? spawnLiveProcess() : await startWithFifo();

if (mode === "fifo-immediate") {
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  process.kill(process.pid, "SIGKILL");
} else if (mode === "fifo-ready") {
  let buffer = "";
  const timer = setTimeout(function noReady() { process.exit(1); }, 10_000);
  child.stdout.on("data", function onData(chunk) {
    buffer += chunk.toString();
    if (!buffer.includes("\\n")) return;
    clearTimeout(timer);
    if (buffer.split("\\n")[0] !== LIVE_PROCESS_READY) process.exit(1);
    console.log(String(child.pid));
  });
} else {
  console.log(String(child.pid));
}

setInterval(function keepAlive() {}, 1000);
`,
  );
  return path;
}

/** A scratch dir with a FIFO whose write end an independent holder keeps open. */
function startFifoFixture(root: string, ownerPid: number, name = "stdin.fifo"): ChildProcess {
  const fifo = join(root, name);
  execFileSync("mkfifo", ["-m", "600", fifo]);
  return spawn(process.execPath, ["-e", HOLDER_SCRIPT, fifo, String(ownerPid)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

type ProofMode = "ready" | "opening";

/**
 * A parent-owned harness that builds the same holder/parent/helper fixtures and
 * records their pids, so the test can kill the owner and watch them exit.
 */
function writeHarnessScript(root: string, parentScript: string, mode: ProofMode): string {
  const path = join(root, "harness.mjs");
  writeFileSync(
    path,
    `
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const parentScript = process.argv[3];
const mode = process.argv[4];
const ownerPid = process.pid;
const HOLDER_SCRIPT = ${JSON.stringify(HOLDER_SCRIPT)};

function startHolder(fifoName, markerPath) {
  const fifo = join(root, fifoName);
  execFileSync("mkfifo", ["-m", "600", fifo]);
  const args = ["-e", HOLDER_SCRIPT, fifo, String(ownerPid)];
  if (markerPath) args.push(markerPath);
  return spawn(process.execPath, args, { stdio: ["ignore", "ignore", "inherit"] });
}

async function waitForFile(path) {
  const deadline = Date.now() + ${EXIT_BOUND_MS};
  for (;;) {
    try {
      readFileSync(path, "utf8");
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPid(parent) {
  if (!parent.stdout) throw new Error("parent has no stdout pipe");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not report the helper pid")), ${EXIT_BOUND_MS});
    let buffer = "";
    parent.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\\n")[0];
      if (!line) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
  });
}

const holder = startHolder("stdin.fifo");
const parent = spawn(process.execPath, [parentScript, String(ownerPid)], { stdio: ["ignore", "pipe", "inherit"] });
const helper = await readPid(parent);
const pids = { holder: holder.pid, parent: parent.pid, helper };
if (mode === "opening") {
  const marker = join(root, "waiting.started");
  const waiting = startHolder("waiting.fifo", marker);
  await waitForFile(marker);
  await new Promise((resolve) => setTimeout(resolve, 250));
  pids.waiting = waiting.pid;
}
writeFileSync(join(root, "pids.json"), JSON.stringify(pids));
setInterval(function park() {}, 1000);
`,
  );
  return path;
}

type FixturePids = { holder: number; parent: number; helper: number; waiting?: number };

async function readPidsFile(path: string): Promise<FixturePids> {
  const deadline = Date.now() + EXIT_BOUND_MS;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return JSON.parse(text) as FixturePids;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("harness did not record the fixture pids");
}

test("the helper exits when its stdin closes while its parent is alive", async () => {
  const child = spawnLiveProcess();
  const pid = child.pid as number;
  const stdin = child.stdin;
  if (!stdin) throw new Error("helper child has no stdin pipe");
  try {
    expect(pid).toBeGreaterThan(0);
    expect(isRunning(pid)).toBe(true);
    stdin.end();
    expect(await waitForExit(pid)).toBe(true);
  } finally {
    kill(pid);
  }
}, 30_000);

test("the helper exits after its parent is SIGKILLed without teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-helper-"));
  const parent = spawn(process.execPath, [writeParentScript(root, "pipe"), String(process.pid)], {
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
}, 30_000);

test("the parent pid watch ends the helper when the parent dies after it starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-fifo-ready-"));
  const holder = startFifoFixture(root, process.pid);
  const parent = spawn(process.execPath, [writeParentScript(root, "fifo-ready"), String(process.pid)], {
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
    kill(holder.pid);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("the parent pid watch ends the helper when the parent dies at spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-fifo-early-"));
  const holder = startFifoFixture(root, process.pid);
  const parent = spawn(process.execPath, [writeParentScript(root, "fifo-immediate"), String(process.pid)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  let childPid: number | undefined;
  try {
    childPid = await readPidFile(join(root, "helper.pid"));
    expect(childPid).toBeGreaterThan(0);
    await waitForParentExit(parent);
    expect(await waitForExit(childPid)).toBe(true);
    expect(readFileSync(join(root, "helper.out"), "utf8")).toBe(`${LIVE_PROCESS_READY}\n`);
  } finally {
    kill(childPid);
    kill(parent.pid);
    kill(holder.pid);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a normal teardown still stops the helper", async () => {
  const child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  expect(isRunning(pid)).toBe(true);
  child.kill("SIGKILL");
  await waitForParentExit(child);
  expect(isRunning(pid)).toBe(false);
}, 30_000);

for (const mode of ["ready", "opening"] as const) {
  test(`a SIGKILLed fixture owner takes every fixture with it (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "live-process-proof-"));
    const parentScript = writeParentScript(root, "fifo-ready");
    const harness = spawn(process.execPath, [writeHarnessScript(root, parentScript, mode), root, parentScript, mode], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    let pids: FixturePids | undefined;
    try {
      pids = await readPidsFile(join(root, "pids.json"));
      for (const pid of Object.values(pids)) expect(isRunning(pid)).toBe(true);
      harness.kill("SIGKILL");
      await waitForParentExit(harness);
      for (const [name, pid] of Object.entries(pids)) {
        expect({ name, exited: await waitForExit(pid) }).toEqual({ name, exited: true });
      }
    } finally {
      kill(harness.pid);
      for (const pid of Object.values(pids ?? {})) kill(pid);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
