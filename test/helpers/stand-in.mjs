/**
 * cli#1016 — the keep-alive stand-in for tests that need a live process.
 *
 * An interrupted run (a harness kill, a timeout, a signal) skips the test's
 * cleanup, and an inline `setInterval` child then stays alive under init. A
 * stand-in watches an owner process instead and exits once that owner is gone.
 *
 * cli#1087 — the owner is an identity, not a pid: the kernel reuses pids, so
 * the watch compares the owner's start token, taken before the watch
 * starts. A pid that now names a different process, an owner that exited but
 * was not reaped (a zombie), and a probe that cannot verify the owner all
 * read as gone.
 *
 * The owner is the test process (`process.pid` of the test runner). A fixture
 * that deliberately outlives its spawner is still owned by the test that
 * started it, so the test passes its pid and start token down to the fixture.
 */
import { spawn } from "node:child_process";

/** How often a watch probes the owner. */
export const STAND_IN_POLL_MS = 1000;

/** A builtin module, from `require` where the program has one (CJS, bun) and
 *  from `process.getBuiltinModule` where it does not (ESM). */
function standInBuiltin(name) {
  if (typeof process.getBuiltinModule === "function") return process.getBuiltinModule(name);
  return require(name);
}

/** `standInBuiltin`'s source for the generated program. Written out rather than
 *  taken from `toString`: a bundler may fold the guard for its own runtime and
 *  emit a program the other one cannot run. */
const STAND_IN_BUILTIN_SOURCE = [
  "function standInBuiltin(name) {",
  '  if (typeof process.getBuiltinModule === "function") return process.getBuiltinModule(name);',
  "  return require(name);",
  "}",
].join("\n");

/**
 * The owner's start token: its process start time, tagged with where it was
 * read. Throws when the owner cannot be verified: no such process, an owner
 * that exited and is still unreaped, or any other read error.
 */
export function standInOwnerStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("the owner's pid must be a positive integer");
  }
  if (process.platform === "linux") {
    const raw = standInBuiltin("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces and parentheses: the rest starts after
    // the last ")", so rest[0] is field 3 (state) and rest[19] is field 22
    // (starttime, in clock ticks since boot).
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (rest.length < 20) throw new Error(`owner ${pid} has an unreadable stat line`);
    if (rest[0] === "Z") throw new Error(`owner ${pid} has exited and is unreaped`);
    return `linux:${rest[19]}`;
  }
  const ps = standInBuiltin("node:child_process").spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error) throw ps.error;
  const out = (ps.stdout ?? "").trim();
  if (ps.status !== 0 || out === "") throw new Error(`no process ${pid}`);
  const [state, ...rest] = out.split(/\s+/);
  if (state.startsWith("Z")) throw new Error(`owner ${pid} has exited and is unreaped`);
  return `ps:${rest.join(" ")}`;
}

/** True unless `probe` verifies the same live owner process. A probe that
 *  throws cannot verify the owner, and that counts as gone too. */
export function standInOwnerLost(ownerPid, startToken, probe = standInOwnerStartToken) {
  try {
    return probe(ownerPid) !== startToken;
  } catch {
    return true;
  }
}

/**
 * Program text: stays alive and exits once the owner is gone, replaced or
 * unverifiable. `ownerStart` defaults to the owner's token now, which is
 * before the stand-in starts if the caller builds the text before spawning.
 * `probe` replaces the owner probe, for tests of an unverifiable one.
 * The tail installs no signal handler and preserves the caller’s existing signal behavior.
 */
export function standInTail(ownerPid, ownerStart = standInOwnerStartToken(ownerPid), probe = standInOwnerStartToken) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new TypeError("standInTail needs the owner's pid: the test process's pid");
  }
  return `${STAND_IN_BUILTIN_SOURCE}
${standInOwnerStartToken.toString()}
${standInOwnerLost.toString()}
const standInOwnerPid = ${ownerPid};
const standInOwnerStart = ${JSON.stringify(ownerStart)};
const standInOwnerProbe = ${probe.toString()};
setInterval(() => {
  if (standInOwnerLost(standInOwnerPid, standInOwnerStart, standInOwnerProbe)) process.exit(0);
}, ${STAND_IN_POLL_MS});
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

/** The owner pid and start token a fixture receives from the test that
 *  spawned it. */
export function standInOwnerFromEnv(env = process.env) {
  const pid = standInOwnerPidFromEnv(env);
  const start = env.TPS_STAND_IN_OWNER_START;
  if (typeof start !== "string" || start === "") {
    throw new Error("TPS_STAND_IN_OWNER_START is not set: a fixture needs the owner's start token");
  }
  return { pid, start };
}

/** Keep this process alive until the test that spawned it is gone. */
export function stayAliveUntilOwnerGone(ownerPid = standInOwnerPidFromEnv(), ownerStart = standInOwnerStartToken(ownerPid)) {
  setInterval(() => {
    if (standInOwnerLost(ownerPid, ownerStart)) process.exit(0);
  }, STAND_IN_POLL_MS);
}

/**
 * Start a stand-in. `command` selects the runtime the caller is exercising;
 * `ownerPid` defaults to this test process, `ownerStart` to that process's
 * token now (before the spawn), and `probe` replaces the owner probe.
 */
export function spawnStandIn(options = {}) {
  const {
    ownerPid = process.pid,
    ownerStart = standInOwnerStartToken(ownerPid),
    probe = standInOwnerStartToken,
    command = process.execPath,
    args = [],
    stdin = "ignore",
    stdout = "ignore",
    stderr = "ignore",
  } = options;
  return spawn(command, [...args, "-e", standInTail(ownerPid, ownerStart, probe)], { stdio: [stdin, stdout, stderr] });
}
