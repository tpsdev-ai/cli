/**
 * cli#693 — the shared live-process helper must not outlive the test process
 * that started it when teardown is skipped (a killed test process, a timed-out
 * lane). The helper watches stdin close and its spawner's pid.
 */
import { expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIVE_PROCESS_READY, spawnLiveProcess } from "./helpers/live-process.js";

/** Operational test allowance for the child to act on a parent death. */
const EXIT_BOUND_MS = 15_000;

/** Opens the FIFO for writing and holds it open while the fixture lives. */
const HOLDER_SCRIPT = `require("node:fs").openSync(process.argv[1], "w"); setInterval(() => {}, 1000);`;

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
 * writes the pid and SIGKILLs itself immediately after the spawn.
 */
function writeParentScript(root: string, mode: ParentMode): string {
  const fifo = join(root, "stdin.fifo");
  const marker = join(root, "helper.out");
  const pidFile = join(root, "helper.pid");
  const path = join(root, `parent-${mode}.ts`);
  writeFileSync(
    path,
    `
import { openSync, writeFileSync } from "node:fs";
import { LIVE_PROCESS_READY, spawnLiveProcess } from ${JSON.stringify(HELPER_URL)};

const mode = ${JSON.stringify(mode)};

function startWithFifo() {
  const stdin = openSync(${JSON.stringify(fifo)}, "r");
  const stdout = mode === "fifo-immediate" ? openSync(${JSON.stringify(marker)}, "w") : "pipe";
  return spawnLiveProcess({ stdin, stdout });
}

const child = mode === "pipe" ? spawnLiveProcess() : startWithFifo();

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
function startFifoFixture(root: string): ChildProcess {
  const fifo = join(root, "stdin.fifo");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  return spawn(process.execPath, ["-e", HOLDER_SCRIPT, fifo], { stdio: ["ignore", "ignore", "inherit"] });
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
  const parent = spawn(process.execPath, [writeParentScript(root, "pipe")], {
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
  const holder = startFifoFixture(root);
  const parent = spawn(process.execPath, [writeParentScript(root, "fifo-ready")], {
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

test("the parent pid watch ends the helper when the parent dies before it starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-process-fifo-early-"));
  const holder = startFifoFixture(root);
  const parent = spawn(process.execPath, [writeParentScript(root, "fifo-immediate")], {
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
