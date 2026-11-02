/**
 * cli#693 — one shared live-process helper for tests.
 *
 * Tests that need a process to stay alive while they probe it must not outlive
 * the test run when teardown is skipped (a killed test process, a timed-out
 * lane). The child watches its parent two ways and exits on its own:
 *
 * - stdin closes: the parent holds the write end of a pipe, so the kernel
 *   closes it the moment the parent exits or is killed. This is immediate.
 * - ppid changes: covers a parent that dies without closing the pipe (another
 *   process holds a duplicate of the write end). The child compares against the
 *   ppid it started with, not against 1, because a Linux subreaper may adopt it.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** The program the helper runs: stay alive until its parent goes away. */
export const LIVE_PROCESS_SCRIPT = `
const parentPid = process.ppid;
const stop = () => process.exit(0);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
setInterval(() => {
  if (process.ppid !== parentPid) stop();
}, 250);
`;

/** Start a process that exits when this process does, even without teardown. */
export function spawnLiveProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", LIVE_PROCESS_SCRIPT], { stdio: ["pipe", "ignore", "ignore"] });
}
