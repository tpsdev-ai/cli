// Synchronise on a child's termination at the OS level without yielding to
// node's event loop, so its exit event stays pending for the caller's recheck.
import { spawnSync } from "node:child_process";

const POLL_MS = 25;
const PS_TIMEOUT_MS = 5_000;

/**
 * "running", "zombie" (terminated but not yet reaped) or "gone". Linux
 * reports the state in /proc/<pid>/stat and macOS through the same kernel
 * state; `ps -o stat=` reads it on both, with no output and exit status 1 for
 * a pid that no longer exists.
 */
function processState(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf-8",
    timeout: PS_TIMEOUT_MS,
  });
  if (result.error) throw new Error(`process state probe for pid ${pid} failed: ${result.error.message}`);
  const stat = (result.stdout ?? "").trim();
  if (result.status === 1) return "gone";
  if (result.status !== 0) {
    throw new Error(
      `process state probe for pid ${pid} failed with status ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  if (stat === "") throw new Error(`process state probe for pid ${pid} printed no state`);
  return stat.startsWith("Z") ? "zombie" : "running";
}

/**
 * Block until the pid is a zombie or gone, polling at most every `pollMs` up
 * to `timeoutMs`. A zombie means the process has ended at the OS level while
 * node has not reaped it, so its exit event is still pending.
 */
export function waitForTermination(pid, { timeoutMs = 5_000, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = processState(pid);
    if (state !== "running") return state;
    if (Date.now() >= deadline) {
      throw new Error(`pid ${pid} was still running after ${timeoutMs}ms`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
