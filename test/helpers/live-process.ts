/**
 * cli#693 — one shared live-process helper for tests.
 *
 * Tests that need a process to stay alive while they probe it must not outlive
 * the test run when teardown is skipped (a killed test process, a timed-out
 * lane). The child watches two things and exits on its own:
 *
 * - stdin closes: by default the spawner holds the write end of a pipe, so the
 *   kernel closes it the moment the spawner exits or is killed. This is immediate.
 * - the spawner's pid: read from this process before the spawn and passed to
 *   the child, which probes it every 250 ms and exits when the probe reports
 *   ESRCH (gone), EPERM (another user's process), or a Linux zombie's Z state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

/** Printed by the child once its watches are installed. */
export const LIVE_PROCESS_READY = "live-process-ready";

/**
 * Program text: defines `ownerGone(pid)`, true when the pid is gone. A Linux
 * zombie counts as gone (/proc/<pid>/stat state Z): the pid probe alone reports
 * a zombie as alive, and under a PID 1 that does not reap (a container without
 * an init) an exited owner stays a zombie. Elsewhere the probe is the whole
 * check.
 */
export const OWNER_GONE_SCRIPT = `
function ownerGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means "owner gone, exit" here, because the question is "is my owner still mine".
    // The agent package's pidState classifies EPERM as "alive" because its question is "is anything at this pid".
    return error.code === "ESRCH" || error.code === "EPERM";
  }
  if (process.platform === "linux") {
    try {
      const stat = require("node:fs").readFileSync("/proc/" + pid + "/stat", "utf8");
      const nameEnd = stat.lastIndexOf(")");
      return stat.slice(nameEnd + 2, nameEnd + 3) === "Z";
    } catch {
      return true;
    }
  }
  return false;
}
`;

/** The program the helper runs: exit when its stdin closes or the spawner's pid is gone. */
export const LIVE_PROCESS_SCRIPT = `
const parentPid = Number(process.argv[1]);
if (!Number.isInteger(parentPid) || parentPid <= 0) process.exit(2);
const stop = () => process.exit(0);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
${OWNER_GONE_SCRIPT}
// A same-user process that reuses the pid within one poll interval keeps this alive.
setInterval(() => {
  if (ownerGone(parentPid)) stop();
}, 250);
process.stdout.write("${LIVE_PROCESS_READY}\\n");
`;

export interface SpawnLiveProcessOptions {
  /** Child stdin: a pipe the spawner holds (default), or an open fd to pass through. */
  stdin?: "pipe" | number;
  /** Child stdout: "ignore" (default), "pipe" to await LIVE_PROCESS_READY, or an open fd. */
  stdout?: "ignore" | "pipe" | number;
}

/** Start a process that exits when its stdin closes or its spawner's pid is gone. */
export function spawnLiveProcess(options: SpawnLiveProcessOptions = {}): ChildProcess {
  const parentPid = process.pid;
  return spawn(process.execPath, ["-e", LIVE_PROCESS_SCRIPT, String(parentPid)], {
    stdio: [options.stdin ?? "pipe", options.stdout ?? "ignore", "ignore"],
  });
}

/** A worker child started by `spawnWatchedWorker`: stdin is a pipe the spawner holds. */
export type WatchedWorker = ReturnType<typeof Bun.spawn>;

/**
 * Program text a worker prepends (after its imports): reads the spawner pid from
 * the last argv entry, exits when stdin closes, and polls the spawner pid.
 */
export const WORKER_OWNER_WATCH_SCRIPT = `
const ownerPid = Number(process.argv[process.argv.length - 1]);
if (!Number.isInteger(ownerPid) || ownerPid <= 0) process.exit(2);
const stop = () => process.exit(0);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
${OWNER_GONE_SCRIPT}
setInterval(() => {
  if (ownerGone(ownerPid)) stop();
}, 250);
`;

/**
 * Program text for a synchronous `release-<name>` file gate that exits when the
 * owner is gone. Expects `fs`, `join`, `root` and `ownerGone` in scope, from
 * WORKER_OWNER_WATCH_SCRIPT. A worker blocked in this loop still checks the
 * owner on every pass. `entryFile`, when given, is written on the first pass so
 * a test can prove the worker reached the loop.
 */
export function ownerAwareGateWaitScript(timeoutMs = 5_000, entryFile?: string): string {
  const writeEntry = entryFile === undefined
    ? ""
    : `    if (!signaled) { fs.writeFileSync(join(root, ${JSON.stringify(entryFile)}), "waiting"); signaled = true; }\n`;
  return `
const wait = (name) => {
  const deadline = Date.now() + ${timeoutMs};
  let signaled = false;
  while (!fs.existsSync(join(root, name))) {
${writeEntry}    if (ownerGone(ownerPid)) process.exit(0);
    if (Date.now() > deadline) throw new Error("barrier timeout: " + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
`;
}

/**
 * Start a worker whose stdin stays a pipe held by this process and whose last
 * argv entry is this process's pid, so it exits with the test process.
 */
export function spawnWatchedWorker(workerPath: string, args: string[]): WatchedWorker {
  return Bun.spawn([process.execPath, workerPath, ...args, String(process.pid)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Whether the pid is still running. A Linux zombie counts as gone (OWNER_GONE_SCRIPT's rule). */
export function pidIsRunning(pid: number): boolean {
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

/** Wait until the pid is gone (a Linux zombie counts as gone), or the deadline passes. */
export async function waitForPidGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidIsRunning(pid);
}

/** Wait for a spawned child to exit, resolving undefined at the deadline. */
export async function waitForChildExit(child: WatchedWorker, timeoutMs = 5_000): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([child.exited, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Stop a child: terminate, then SIGKILL and wait again at the deadline. */
export async function stopChild(child: WatchedWorker, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // already gone
  }
  if ((await waitForChildExit(child, timeoutMs)) !== undefined) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  await waitForChildExit(child, timeoutMs);
}
