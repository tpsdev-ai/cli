/**
 * cli#1016 — the keep-alive stand-in for tests that need a live process.
 *
 * An interrupted run (a harness kill, a timeout, a signal) skips the test's
 * cleanup, and an inline `setInterval` child then stays alive under init. A
 * stand-in watches an owner pid instead and exits once that owner is gone.
 *
 * The owner is the test process (`process.pid` of the test runner). A fixture
 * that deliberately outlives its spawner is still owned by the test that
 * started it, so the test passes its pid down to the fixture.
 */
import { spawn } from "node:child_process";

/** True once the pid is gone. */
export function standInOwnerGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  return false;
}

/**
 * Program text: stays alive and exits once `ownerPid` is gone. Use it as the
 * whole program of a stand-in, or as the tail of a generated script.
 * The tail installs no signal handler and preserves the caller’s existing signal behavior.
 */
export function standInTail(ownerPid) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new TypeError("standInTail needs the owner's pid: the test process's pid");
  }
  return `${standInOwnerGone.toString()}
const standInOwnerPid = ${ownerPid};
setInterval(() => {
  if (standInOwnerGone(standInOwnerPid)) process.exit(0);
}, 1000);
`;
}

/** The owner pid a fixture receives from the test that spawned it. */
export function standInOwnerPidFromEnv(env = process.env) {
  const pid = Number(env.TPS_STAND_IN_OWNER_PID);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("TPS_STAND_IN_OWNER_PID is not set: a fixture needs the test process's pid");
  }
  return pid;
}

/** Keep this process alive until the test that spawned it is gone. */
export function stayAliveUntilOwnerGone(ownerPid = standInOwnerPidFromEnv()) {
  setInterval(() => {
    if (standInOwnerGone(ownerPid)) process.exit(0);
  }, 1000);
}

/**
 * Start a stand-in. `command` selects the runtime the caller is exercising;
 * `ownerPid` defaults to this test process.
 */
export function spawnStandIn(options = {}) {
  const { ownerPid = process.pid, command = process.execPath, args = [], stdin = "ignore", stdout = "ignore", stderr = "ignore" } = options;
  return spawn(command, [...args, "-e", standInTail(ownerPid)], { stdio: [stdin, stdout, stderr] });
}
