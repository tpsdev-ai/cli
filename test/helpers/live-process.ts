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
 *   the child, which probes it with process.kill(pid, 0) every 250 ms and exits
 *   when the probe reports ESRCH (gone) or EPERM (another user's process).
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Printed by the child once its watches are installed. */
export const LIVE_PROCESS_READY = "live-process-ready";

/** The program the helper runs: exit when its stdin closes or the spawner's pid is gone. */
export const LIVE_PROCESS_SCRIPT = `
const parentPid = Number(process.argv[1]);
if (!Number.isInteger(parentPid) || parentPid <= 0) process.exit(2);
const stop = () => process.exit(0);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
// A same-user process that reuses the pid within one poll interval keeps this alive.
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    // EPERM means "parent gone, exit" here, because the question is "is my parent still mine".
    // The agent package's pidState classifies EPERM as "alive" because its question is "is anything at this pid".
    if (error.code === "ESRCH" || error.code === "EPERM") stop();
  }
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
