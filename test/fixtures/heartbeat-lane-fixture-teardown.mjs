// Shared teardown for heartbeat-lane fixtures that start a detached stub
// gateway. A fixture killed by a signal never reaches its `finally` block, so
// the gateway's process group is stopped from the fixture's SIGTERM, SIGINT and
// `exit` handlers instead.
//
// The pid passed here may be the detached gateway's own pid, recorded when the
// fixture spawned it, or that gateway's ChildProcess. Because the gateway was
// started with `detached: true`, it leads its own process group, so `-pid`
// targets that group. After cleanup is confirmed (no live member on Linux, no
// member at all elsewhere) the handlers are removed and the pgid is forgotten,
// so a later signal or exit cannot signal a group that reused the number. An
// unconfirmed cleanup writes one line naming the pgid and, on Linux, the
// surviving pids to stderr and exits nonzero.
import { readdirSync, readFileSync, writeSync } from "node:fs";

const SIGNAL_EXIT_STATUS = { SIGTERM: 143, SIGINT: 130 };
const TERM_WAIT_MS = 2000;
const KILL_WAIT_MS = 1000;
const CHILD_WAIT_MS = 3000;
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

/** Field 3 (state) and field 5 (process group) of a Linux `/proc/<pid>/stat`
 *  line. Field 2 (comm) may contain spaces and parentheses, so both follow the
 *  space after the last `)`. Null when the pid has no entry; other read errors
 *  are rethrown. */
function procStat(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
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
function procGroupMembers(pid) {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const info = procStat(Number(entry));
    if (info !== null && info.pgrp === pid && info.state !== "Z") members.push(Number(entry));
  }
  return members;
}

/** True while the group has a live member: the Linux `/proc` rule when it is
 *  readable, `kill(-pgid, 0)` elsewhere. */
function groupAlive(pid) {
  const members = procGroupMembers(pid);
  if (members !== null) return members.length > 0;
  return groupExists(pid);
}

/** Surviving pids for the unconfirmed-cleanup line: the live members on Linux,
 *  an empty array when the group is gone, and null when the platform cannot
 *  enumerate them. */
function survivingPids(pid) {
  const members = procGroupMembers(pid);
  if (members !== null) return members;
  return groupExists(pid) ? null : [];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function waitForGroupExit(pid, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  return !groupAlive(pid);
}

function waitForGroupExitSync(pid, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return !groupAlive(pid);
}

// A signal is sent only if the group had a live member when it was checked.
// The check and the signal are separate calls, so the last member can exit in
// between; the gateway is the group leader, so the number cannot be reused
// while any member, zombie included, exists, which keeps the remaining window
// to the gap between the check and the signal.
async function stopGroup(pid, termWaitMs, killWaitMs, pollMs) {
  if (groupAlive(pid)) signalGroup(pid, "SIGTERM");
  if (await waitForGroupExit(pid, termWaitMs, pollMs)) return true;
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  return waitForGroupExit(pid, killWaitMs, pollMs);
}

function stopGroupSync(pid, termWaitMs, killWaitMs, pollMs) {
  if (groupAlive(pid)) signalGroup(pid, "SIGTERM");
  if (waitForGroupExitSync(pid, termWaitMs, pollMs)) return true;
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  return waitForGroupExitSync(pid, killWaitMs, pollMs);
}

/** Wait, bounded, for the fixture's own gateway child to be reaped. A child
 *  that is still unreaped keeps the group answering `kill(-pgid, 0)` even
 *  after it has exited. */
function waitForChildExit(child, waitMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, waitMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

/**
 * Stop the detached gateway group when the fixture is terminated. Before each
 * signal it checks that the group still has a live member; once cleanup is
 * confirmed (no live member on Linux, no member at all elsewhere) it removes
 * its handlers and forgets the pgid, so a later signal or exit is not signalled
 * to a reused number. A group that already exited is left alone. When a bounded
 * wait and a SIGKILL still leave a member, it writes one line naming the pgid
 * and, on Linux, the surviving pids to stderr and makes the exit status
 * nonzero.
 *
 * `probeSurvivors` replaces only the confirmation probe. It exists so a test
 * can report a survivor: a group member that ignores SIGTERM and SIGKILL
 * cannot be built portably.
 */
export function installGatewayTeardown(target, options = {}) {
  const {
    termWaitMs = TERM_WAIT_MS,
    killWaitMs = KILL_WAIT_MS,
    pollMs = POLL_MS,
    childWaitMs = CHILD_WAIT_MS,
    probeSurvivors = survivingPids,
  } = options;
  const pid = typeof target === "number" ? target : target?.pid;
  const child = typeof target === "number" ? null : target;
  if (!Number.isInteger(pid) || pid <= 0) return;

  let pgid = pid;
  let armed = true;
  const handlers = new Map();

  function disarm() {
    if (!armed) return;
    armed = false;
    for (const [event, handler] of handlers) process.removeListener(event, handler);
    handlers.clear();
    pgid = null;
  }

  // Cleanup is confirmed by the probe, not by the attempt: a probe that
  // reports a survivor, or cannot report, leaves the status nonzero.
  function settle() {
    const survivors = probeSurvivors(pid);
    return { confirmed: survivors !== null && survivors.length === 0, survivors };
  }

  function report(pid, survivors) {
    const detail = survivors === null ? "" : `: ${survivors.join(", ")}`;
    writeSync(2, `gateway teardown: process group ${pid} still has a member after SIGKILL${detail}\n`);
  }

  for (const signal of Object.keys(SIGNAL_EXIT_STATUS)) {
    const handler = () => {
      const target = pgid;
      if (target === null) return;
      void (async () => {
        try {
          await stopGroup(target, termWaitMs, killWaitMs, pollMs);
          const { confirmed, survivors } = settle();
          if (confirmed) {
            disarm();
            await waitForChildExit(child, childWaitMs);
            process.exit(SIGNAL_EXIT_STATUS[signal]);
          }
          disarm();
          report(target, survivors);
          process.exit(1);
        } catch (error) {
          disarm();
          writeSync(2, `gateway teardown: failed to stop process group ${target}: ${error?.message ?? error}\n`);
          process.exit(1);
        }
      })();
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  const exitHandler = () => {
    const target = pgid;
    if (!armed || target === null) return;
    try {
      stopGroupSync(target, termWaitMs, killWaitMs, pollMs);
      const { confirmed, survivors } = settle();
      if (confirmed) {
        disarm();
        return;
      }
      disarm();
      report(target, survivors);
      process.exitCode = 1;
    } catch (error) {
      disarm();
      writeSync(2, `gateway teardown: failed to stop process group ${target}: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  };
  handlers.set("exit", exitHandler);
  process.once("exit", exitHandler);
}
