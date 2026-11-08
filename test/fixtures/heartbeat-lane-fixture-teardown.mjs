// Shared teardown for heartbeat-lane fixtures that start a detached stub
// gateway. A fixture killed by a signal never reaches its `finally` block, so
// the gateway's process group is stopped from the fixture's SIGTERM, SIGINT and
// `exit` handlers instead.
//
// The pid passed here is the detached gateway's own pid, recorded when the
// fixture spawned it. Because the gateway was started with `detached: true`, it
// leads its own process group, so `-pid` names that group and nothing else: the
// fixture's own group is never signalled.
const SIGNAL_EXIT_STATUS = { SIGTERM: 143, SIGINT: 130 };
const TERM_WAIT_MS = 2000;
const KILL_WAIT_MS = 1000;
const POLL_MS = 25;

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function waitForGroupExit(pid, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  return !groupExists(pid);
}

function waitForGroupExitSync(pid, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  while (groupExists(pid) && Date.now() < deadline) {
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return !groupExists(pid);
}

async function stopGroup(pid, termWaitMs, killWaitMs, pollMs) {
  signalGroup(pid, "SIGTERM");
  if (await waitForGroupExit(pid, termWaitMs, pollMs)) return true;
  signalGroup(pid, "SIGKILL");
  return waitForGroupExit(pid, killWaitMs, pollMs);
}

function stopGroupSync(pid, termWaitMs, killWaitMs, pollMs) {
  signalGroup(pid, "SIGTERM");
  if (waitForGroupExitSync(pid, termWaitMs, pollMs)) return true;
  signalGroup(pid, "SIGKILL");
  return waitForGroupExitSync(pid, killWaitMs, pollMs);
}

/**
 * Stop the detached gateway group when the fixture is terminated. Idempotent:
 * a group that already exited is a no-op, and the exit handler after a signal
 * handler finds nothing to stop.
 */
export function installGatewayTeardown(pid, options = {}) {
  const { termWaitMs = TERM_WAIT_MS, killWaitMs = KILL_WAIT_MS, pollMs = POLL_MS } = options;
  if (!Number.isInteger(pid) || pid <= 0) return;
  let stopped = false;

  for (const signal of Object.keys(SIGNAL_EXIT_STATUS)) {
    process.once(signal, () => {
      void (async () => {
        try {
          await stopGroup(pid, termWaitMs, killWaitMs, pollMs);
        } finally {
          stopped = true;
          process.exit(SIGNAL_EXIT_STATUS[signal]);
        }
      })();
    });
  }

  process.once("exit", () => {
    if (stopped || !groupExists(pid)) return;
    stopped = true;
    stopGroupSync(pid, termWaitMs, killWaitMs, pollMs);
  });
}
