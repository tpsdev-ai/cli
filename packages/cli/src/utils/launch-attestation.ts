/**
 * cli#350 round 4e — the launcher's confinement attestation.
 *
 * INVARIANT (CLI launch point only; in the Docker lane the container is the
 * boundary): every launch through `tps agent start` runs its workload inside a
 * nono session that the LAUNCHER started, bound to the pid the launcher spawned
 * AND to the pid the child reports, with enforcement verified BEHAVIOURALLY from
 * outside the sandbox — or the child is never released.
 *
 * Why behavioural, not a nono audit record (round 4e): nono 0.74.0 writes its
 * per-session `sandbox_runtime` audit record ONLY when tool-sandbox is active
 * (`command_policies.commands` non-empty), and activating tool-sandbox changes
 * the launch shape (`nono ps` then reports the shim pid as `child_pid`, and
 * commands are denied by default) — the pid binding and an audit-record
 * attestation are mutually exclusive on the plain launch, and on the plain shape
 * nothing in nono's own state names a backend. The launcher's ground truth is
 * therefore two canaries it plants itself:
 *
 *   OUTSIDE  a file at a root covered by NO grant the launch passes, which the
 *            launcher verifies it can read OUTSIDE the sandbox with its own uid
 *   INSIDE   its twin inside <priv>/sock/ — the one directory the launch grants
 *
 * The child must be unable to read OUTSIDE while reading INSIDE (with the
 * launcher's fresh nonce). A child that merely echoes `DENIED` fails the INSIDE
 * check; a child that is not really sandboxed reads OUTSIDE and is refused.
 *
 * The launcher owns the whole mechanism: the private 0700 dir (pinned at a root
 * no grant covers), the unix socket (the capability; the env var is only a
 * locator), the canaries, the nono spawn (by an ABSOLUTE path — never PATH), the
 * launcher-pinned XDG_STATE_HOME (never inherited) and every cleanup path,
 * including refuse and kill. The child cannot attest its own confinement: its
 * check is a guard against an UNWRAPPED launch, not a boundary against the
 * process that spawns it — that process already owns it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, Socket, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  buildNonoArgs,
  checkProfileLoadable,
  EX_CONFIG,
  isSupervised,
  NONO_MIN_VERSION,
  nonoVersion,
  REFUSAL_EXIT_CODE,
  sandboxChildEnv,
  SUPERVISED_REFUSAL_EXIT_CODE,
  versionAtLeast,
  type NonoOptions,
  type NonoProfile,
} from "./nono.js";

/** Locator for the launcher's unix socket. Set by the launcher on the nono
 * child (nono preserves the environment unchanged). The socket is the
 * capability; this variable only says where it lives. */
export const LAUNCH_SOCK_ENV = "TPS_LAUNCH_SOCK";

/** The pinned nono binary — ABSOLUTE, never resolved through PATH. The same
 * variable the S4 pin gate (`scripts/check-nono-pin.sh`) and the S1b profile
 * gate (`scripts/check-nono-profiles.sh`) are driven with, so a lane has one
 * variable to set. A caller who sets it can already play launcher; the
 * attestation below is behavioural, so a wrong binary is still refused. */
export const NONO_BIN_ENV = "NONO_BIN";

/** Where the pinned binary lives when nothing overrides it. Absolute paths
 * only: a shadowed `nono` on PATH must not be able to play the launcher's nono. */
export const DEFAULT_NONO_PATHS = [
  "/usr/local/bin/nono",
  "/usr/bin/nono",
  "/opt/homebrew/bin/nono",
];

/** The S4 pin record (repo root). Checked "where present". */
export const PIN_RECORD_NAME = ".nono-version";

/** Bounded waits (the launch is fail-closed: no release inside the window is a
 * refusal). Overridable for fixtures — a shorter window can only refuse. */
export const LAUNCH_TIMEOUT_ENV = "TPS_LAUNCH_TIMEOUT_MS";
export const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;

/** Layout inside the private dir (the child derives these from LAUNCH_SOCK_ENV):
 *
 *   <priv>/                 0700, covered by NO grant the launch passes
 *   <priv>/canary-outside   the OUTSIDE canary (never granted)
 *   <priv>/sock/            THE ONLY granted subdir
 *   <priv>/sock/launch.sock the capability
 *   <priv>/sock/canary-inside
 *   <priv>/state/           the launcher-pinned XDG_STATE_HOME (nono's state
 *                           root; never granted — nono refuses a state root
 *                           that overlaps a grant)
 */
export const CANARY_OUTSIDE_NAME = "canary-outside";
export const CANARY_INSIDE_NAME = "canary-inside";
export const SOCK_NAME = "launch.sock";
export const SOCK_DIR_NAME = "sock";
export const STATE_DIR_NAME = "state";

// ---------------------------------------------------------------------------
// The pinned binary + the S4 pin record
// ---------------------------------------------------------------------------

export interface NonoResolution {
  bin?: string;
  reason?: string;
  /** The pin record consulted, when one was present. */
  pinPath?: string;
  pinVersion?: string;
}

/** The first absolute candidate that is an executable file, or null. */
function firstAbsoluteExecutable(candidates: readonly string[]): string | null {
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* absent — try the next */
    }
  }
  return null;
}

/**
 * Resolve nono by ABSOLUTE path. Order:
 *   1. $NONO_BIN, but only when it is an absolute path (a relative value, or
 *      anything that would be resolved against PATH, is refused outright)
 *   2. the pinned locations (DEFAULT_NONO_PATHS)
 * Never `which nono` / PATH lookup: a PATH entry is controlled by the caller
 * whose launch this control exists to constrain.
 */
export function resolveNonoBinary(env: NodeJS.ProcessEnv = process.env): NonoResolution {
  const override = env[NONO_BIN_ENV];
  if (override) {
    if (!override.startsWith("/")) {
      return {
        reason:
          `${NONO_BIN_ENV} must be an ABSOLUTE path (got '${override}') — the launcher never ` +
          `resolves nono through PATH`,
      };
    }
    if (!firstAbsoluteExecutable([override])) {
      return { reason: `nono not found at ${NONO_BIN_ENV}=${override}` };
    }
    return { bin: override };
  }
  const found = firstAbsoluteExecutable(DEFAULT_NONO_PATHS);
  if (!found) {
    return {
      reason:
        `nono not found at any pinned path (${DEFAULT_NONO_PATHS.join(", ")}); set ` +
        `${NONO_BIN_ENV} to the pinned binary's absolute path`,
    };
  }
  return { bin: found };
}

/** Candidate pin records, most specific first: beside the binary, up to six
 * levels above this module (a checkout's repo root, whether the module is run
 * from src/ or from dist/), then $HOME. "Where present": no record is not an
 * error — an unsourced pin simply cannot be checked at runtime. */
export function pinRecordCandidates(bin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [join(dirname(bin), PIN_RECORD_NAME)];
  let here = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    out.push(join(here, PIN_RECORD_NAME));
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  out.push(join(env.HOME || homedir() || "/tmp", PIN_RECORD_NAME));
  return out;
}

/** Read the S4 pin record: `version=x.y.z` (informational) and `commit=<40 hex>`
 * (the pin). The `commit` is verified at IMAGE BUILD time (S4's read-only bind
 * mount control); at runtime the launcher can only compare `version`, and it
 * does so loudly when a record is present. */
export function findPinRecord(
  bin: string,
  env: NodeJS.ProcessEnv = process.env
): { path: string; version?: string; commit?: string } | null {
  for (const candidate of pinRecordCandidates(bin, env)) {
    if (!existsSync(candidate)) continue;
    let version: string | undefined;
    let commit: string | undefined;
    for (const line of readFileSync(candidate, "utf-8").split("\n")) {
      const v = line.match(/^version=(\S+)$/);
      if (v) version = v[1];
      const c = line.match(/^commit=(\S+)$/);
      if (c) commit = c[1];
    }
    return { path: candidate, version, commit };
  }
  return null;
}

/**
 * Check the binary against the S4 pin record where one is present. The version
 * must match exactly (the record's `version` is the release the pinned commit
 * was tagged as). An unparseable pin version is a refusal, not a skip: the
 * record exists precisely so the running artifact can be tied to it.
 */
export function checkNonoPin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; pin?: { path: string; version?: string; commit?: string } } | { ok: false; reason: string } {
  const pin = findPinRecord(bin, env);
  if (!pin) return { ok: true };
  if (!pin.version) {
    return {
      ok: false,
      reason: `${pin.path} has no 'version=' line — the pin record exists but cannot be checked`,
    };
  }
  const actual = nonoVersion(bin);
  if (!actual) {
    return { ok: false, reason: `could not read a version out of ${bin} --version` };
  }
  if (actual !== pin.version) {
    return {
      ok: false,
      reason:
        `${bin} reports ${actual} but the pin record ${pin.path} pins ${pin.version}` +
        (pin.commit ? ` (commit ${pin.commit})` : ""),
    };
  }
  if (!versionAtLeast(actual, NONO_MIN_VERSION)) {
    return { ok: false, reason: `nono ${actual} is below the ${NONO_MIN_VERSION} floor` };
  }
  return { ok: true, pin };
}

// ---------------------------------------------------------------------------
// Grants — the OUTSIDE canary must overlap none of them
// ---------------------------------------------------------------------------

export interface GrantList {
  workdir?: string;
  cwd?: string;
  read: string[];
  readFiles: string[];
  allow: string[];
}

/** The grant list the launcher actually passes, as absolute paths. `--allow-cwd`
 * is always passed by buildNonoArgs, so the cwd is a grant too. */
export function grantsOfOptions(
  options: NonoOptions,
  extraAllow: readonly string[] = [],
  cwd: string = process.cwd()
): GrantList {
  return {
    workdir: options.workdir,
    cwd,
    read: [...(options.read ?? [])],
    readFiles: [...(options.readFiles ?? [])],
    allow: [...(options.allow ?? []), ...extraAllow],
  };
}

/** True when `grant` covers `target` (equal, or an ancestor directory of it) —
 * the read-write/read roots that make a canary reachable. `/` (or a root that
 * does not exist as a directory) covers everything. */
export function grantCovers(grant: string, target: string): boolean {
  const g = resolve(grant);
  const t = resolve(target);
  if (g === "/") return true;
  if (t === g) return true;
  return t.startsWith(g.endsWith("/") ? g : `${g}/`);
}

/** The first grant that covers `target`, or null. A FILE grant (--read-file) is
 * an exact path, not a root. */
export function coveringGrant(target: string, grants: GrantList): string | null {
  const roots = [grants.workdir, grants.cwd, ...grants.read, ...grants.allow].filter(
    (p): p is string => Boolean(p)
  );
  for (const g of roots) {
    if (grantCovers(g, target)) return g;
  }
  for (const f of grants.readFiles) {
    if (resolve(f) === resolve(target)) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The private launch dir
// ---------------------------------------------------------------------------

export interface PrivateLaunchDir {
  root: string;
  sockDir: string;
  sockPath: string;
  stateDir: string;
  outsideCanary: string;
  insideCanary: string;
  outsideNonce: string;
  insideNonce: string;
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Create <home>/.tps/launch/<agentId>-<nonce>/{sock,state} with the canaries.
 *
 * The root is pinned under $HOME and NOT derived from TMPDIR/os.tmpdir(): the
 * launch grants the tmpdir read+write, so a naive mkdtemp lands inside a grant,
 * the child legitimately reads OUTSIDE, and a correct launch would be refused.
 * $HOME is not granted wholesale (only <home>/.tps/mail, <home>/.tps/agents/<id>
 * and the workspace are), so a fresh subdir beside them is outside every grant —
 * and the overlap assert below proves it rather than assuming it.
 *
 * NOTE on the unix socket path length: <priv>/sock/launch.sock must stay under
 * the platform's sun_path limit (~104 bytes). $HOME plus a short agent id keeps
 * it there.
 */
export function createPrivateLaunchDir(opts: {
  home?: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): PrivateLaunchDir {
  const home = opts.home ?? opts.env?.HOME ?? homedir() ?? "/tmp";
  const parent = join(home, ".tps", "launch");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `${opts.agentId}-${nonce().slice(0, 8)}`);
  const sockDir = join(root, SOCK_DIR_NAME);
  const stateDir = join(root, STATE_DIR_NAME);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  const outside = { path: join(root, CANARY_OUTSIDE_NAME), value: nonce() };
  const inside = { path: join(sockDir, CANARY_INSIDE_NAME), value: nonce() };
  writeFileSync(outside.path, outside.value, { mode: 0o600 });
  writeFileSync(inside.path, inside.value, { mode: 0o600 });

  return {
    root,
    sockDir,
    sockPath: join(sockDir, SOCK_NAME),
    stateDir,
    outsideCanary: outside.path,
    insideCanary: inside.path,
    outsideNonce: outside.value,
    insideNonce: inside.value,
  };
}

/** Remove the private dir. Called on EVERY launcher exit path (release, refusal,
 * kill, signal) — a leaked directory is exactly the #1683 class of accident. */
export function removePrivateLaunchDir(dir: Pick<PrivateLaunchDir, "root">): void {
  try {
    rmSync(dir.root, { recursive: true, force: true });
  } catch {
    /* best effort: the dir is 0700 and owned by us */
  }
}

// ---------------------------------------------------------------------------
// The child side — derive the canaries from the socket locator
// ---------------------------------------------------------------------------

export interface ChildCanaries {
  sockPath: string;
  outsideCanary: string;
  insideCanary: string;
}

/** The child knows only the socket path; the layout is fixed (see the header). */
export function childCanaries(sockPath: string): ChildCanaries {
  const sockDir = dirname(sockPath);
  const priv = dirname(sockDir);
  return {
    sockPath,
    outsideCanary: join(priv, CANARY_OUTSIDE_NAME),
    insideCanary: join(sockDir, CANARY_INSIDE_NAME),
  };
}

export type CanaryRead = { denied: true } | { denied: false; content: string } | { error: string };

/** Attempt the read. A permission refusal (EACCES/EPERM/EROFS) is DENIED —
 * enforcement. Anything else (ENOENT, EISDIR, …) is an ERROR, never DENIED:
 * a missing canary must not read as "the sandbox denied it". */
export function readCanary(path: string): CanaryRead {
  try {
    return { denied: false, content: readFileSync(path, "utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { denied: true };
    return { error: code ?? "UNKNOWN" };
  }
}

/** Wire form: `DENIED`, `READ:<content>` or `ERROR:<code>`. */
function canaryWire(r: CanaryRead): string {
  if ("denied" in r && r.denied) return "DENIED";
  if ("content" in r) return `READ:${r.content}`;
  return `ERROR:${(r as { error: string }).error}`;
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[LAUNCH_TIMEOUT_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LAUNCH_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Child side: prove that a launcher released THIS pid
// ---------------------------------------------------------------------------

export interface Attestation {
  ok: boolean;
  reason?: string;
  sessionId?: string;
}

/**
 * CHILD side, under `--sandboxed` only. Connect to the launcher's socket, report
 * this process's pid (self-reported: Node/Bun expose no peer credentials on
 * either OS — `getpeereid` returns no pid on macOS, and 4b measured that
 * inherited fds are stripped across `nono run`), attempt both canary reads,
 * report them, and require exactly `CONFINED <session_id> <child_pid>` with
 * `<child_pid>` equal to this pid. Anything else — no locator, connect refused,
 * a wrong pid, a timeout — is a refusal; the caller names the launcher.
 */
export async function attestConfinement(
  env: NodeJS.ProcessEnv = process.env,
  waitMs: number = timeoutMs(env)
): Promise<Attestation> {
  const locator = env[LAUNCH_SOCK_ENV];
  if (!locator) {
    return {
      ok: false,
      reason:
        `${LAUNCH_SOCK_ENV} is not set — this process was not launched by the launcher ` +
        `(an unwrapped invocation of the child form)`,
    };
  }
  const canaries = childCanaries(locator);

  const sock = await connectTo(canaries.sockPath, waitMs);
  if (typeof sock === "string") return { ok: false, reason: sock };

  const outside = canaryWire(readCanary(canaries.outsideCanary));
  const inside = canaryWire(readCanary(canaries.insideCanary));

  try {
    sock.write(`PID ${process.pid}\n`);
    sock.write(`CANARY OUTSIDE ${outside}\n`);
    sock.write(`CANARY INSIDE ${inside}\n`);
    const line = await nextLine(sock, waitMs);
    if (typeof line !== "string") return { ok: false, reason: line.reason };
    const release = line.trim().match(/^CONFINED (\S+) (\d+)$/);
    if (!release) {
      return { ok: false, reason: `launcher wrote '${line.trim()}', not a CONFINED release` };
    }
    const releasedPid = Number.parseInt(release[2]!, 10);
    if (releasedPid !== process.pid) {
      return {
        ok: false,
        reason: `the release names pid ${releasedPid}, not this process (${process.pid})`,
      };
    }
    return { ok: true, sessionId: release[1] };
  } finally {
    sock.end();
    sock.destroy();
  }
}

function connectTo(
  path: string,
  waitMs: number
): Promise<Socket | string> {
  return new Promise((resolvePromise) => {
    // Attach the error handler BEFORE connecting: an emitter that fails during
    // connect() would otherwise throw uncaught.
    const sock = new Socket();
    sock.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolvePromise(`cannot connect to the launcher socket ${path} (${err.code ?? err.message})`);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      resolvePromise(`the launcher socket ${path} did not accept a connection within ${waitMs}ms`);
    }, waitMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolvePromise(sock);
    });
    try {
      sock.connect({ path });
    } catch (err) {
      // Bun throws synchronously for some connect failures (e.g. ENOENT).
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      resolvePromise(`cannot connect to the launcher socket ${path} (${code})`);
    }
  });
}

export type LineResult = string | { reason: string };

/**
 * A newline-framed reader over one socket. The framing must be shared across
 * reads: the child writes its three lines in one burst, so a per-call listener
 * would consume the first line and silently drop the rest (the second read then
 * times out and a correct launch gets refused for the wrong reason).
 */
class LineReader {
  private buffer = "";
  private waiters: Array<(line: LineResult) => void> = [];
  private closed = false;

  constructor(sock: Socket) {
    sock.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.pump();
    });
    sock.on("close", () => {
      this.closed = true;
      this.pump();
    });
    sock.on("error", () => {
      this.closed = true;
      this.pump();
    });
  }

  private pump(): void {
    while (this.waiters.length > 0 && (this.buffer.includes("\n") || this.closed)) {
      const waiter = this.waiters.shift()!;
      const idx = this.buffer.indexOf("\n");
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        waiter(line);
      } else {
        waiter({ reason: "the peer closed the connection without the expected line" });
      }
    }
  }

  next(waitMs: number): Promise<LineResult> {
    return new Promise<LineResult>((resolvePromise) => {
      this.waiters.push(resolvePromise);
      setTimeout(() => {
        const i = this.waiters.indexOf(resolvePromise);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolvePromise({ reason: `no line from the peer within ${waitMs}ms` });
        }
      }, waitMs);
      this.pump();
    });
  }
}

/** Read one newline-terminated line, or a reason string. */
function nextLine(sock: Socket, waitMs: number): Promise<string | { reason: string }> {
  return new Promise((resolvePromise) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise({ reason: `no release from the launcher within ${waitMs}ms` });
    }, waitMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        cleanup();
        resolvePromise(buffer.slice(0, idx));
      }
    };
    const onClose = () => {
      cleanup();
      resolvePromise({ reason: "the launcher closed the connection without releasing this process" });
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("close", onClose);
    };
    sock.on("data", onData);
    sock.on("close", onClose);
  });
}

// ---------------------------------------------------------------------------
// Launcher side
// ---------------------------------------------------------------------------

export interface LaunchOutcome {
  /** Exit code for the CLI (the wrapped child's code when it ran, else a refusal). */
  exitCode: number;
  /** Set when the launch was refused instead of run. */
  refusal?: string;
  sessionId?: string;
  childPid?: number;
  /** Every line a fixture may want to assert on. */
  log: string[];
}

/** Liveness of a pid, portable: `kill(pid, 0)`. Node/Bun expose no waitpid; the
 * design's `waitpid(WNOHANG)` is this check plus the ChildProcess handle's own
 * exitCode, which the launcher also watches. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The nono session record the launcher requires, from `nono ps --all --json`. */
export interface NonoSession {
  session_id?: string;
  supervisor_pid?: number;
  child_pid?: number;
  status?: string;
  profile?: string;
  workdir?: string;
}

/** Parse `nono ps --all --json` (tolerating nono's banner lines). */
export function parseNonoPs(stdout: string): NonoSession[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? (parsed as NonoSession[]) : [];
  } catch {
    return [];
  }
}

/**
 * The binding check: is there a session that nono says is (a) supervised by the
 * pid the launcher spawned, (b) running the pid the child reported, (c) running,
 * and (d) under the profile the launcher passed? Liveness of SOME session is
 * never enough.
 */
export function findBoundSession(
  sessions: readonly NonoSession[],
  pids: { supervisorPid: number; childPid: number; profile: string }
): { session?: NonoSession; reason?: string } {
  const running = sessions.filter((s) => s.status === "running");
  if (running.length === 0) {
    return { reason: `nono reports no running session (saw ${sessions.length} record(s))` };
  }
  const supers = running.filter((s) => s.supervisor_pid === pids.supervisorPid);
  if (supers.length === 0) {
    return {
      reason:
        `no running session is supervised by the pid the launcher spawned ` +
        `(${pids.supervisorPid}); nono reports ${running.map((s) => `${s.session_id}:sup=${s.supervisor_pid},child=${s.child_pid}`).join(", ")}`,
    };
  }
  const bound = supers.filter((s) => s.child_pid === pids.childPid);
  if (bound.length === 0) {
    return {
      reason:
        `the session supervised by ${pids.supervisorPid} runs child_pid ` +
        `${supers.map((s) => s.child_pid).join("/")}, not the pid the child reported (${pids.childPid})`,
    };
  }
  const profiled = bound.filter((s) => s.profile === pids.profile);
  if (profiled.length === 0) {
    return {
      reason:
        `the bound session runs profile '${bound.map((s) => s.profile).join("/")}', not ` +
        `'${pids.profile}' — what the launcher passed`,
    };
  }
  return { session: profiled[0] };
}

export interface LaunchOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: where the private dir is created (default: $HOME). */
  home?: string;
  /** Test seam: the handshake window for this launch (fixtures shorten it). */
  timeoutMs?: number;
  /**
   * FAILS-FIRST SEAM — IN-PROCESS ONLY, and deliberately not reachable from the
   * shipped control: nothing under bin/ or src/commands/ constructs this, so
   * there is no environment variable, flag or config that disables either check
   * on a real launch. It exists so a fixture can show that removing a check
   * turns ITS fixture green — i.e. that the check is what refuses, and the
   * fixture is not passing for some unrelated reason.
   */
  failFirstSeam?: {
    disableCanaryCheck?: boolean;
    disablePidBinding?: boolean;
  };
}

/**
 * LAUNCHER side. Wrap `cmd` in a nono session the launcher starts, and release
 * the child over a launcher-owned unix socket only after every check passes.
 */
export async function launchAttested(
  profile: NonoProfile,
  options: NonoOptions,
  cmd: string[],
  opts: LaunchOptions = {}
): Promise<number> {
  const env = opts.env ?? process.env;
  const refusedCode = isSupervised(env) ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE;
  const log: string[] = [];
  const refuse = (reason: string): number => {
    console.error(`❌ refusing to launch: ${reason}`);
    return refusedCode;
  };

  // (1) the pinned binary, by absolute path, checked against the S4 record.
  const resolved = resolveNonoBinary(env);
  if (!resolved.bin) return refuse(`${resolved.reason} — a launch is never run unverified`);
  const bin = resolved.bin;
  const pin = checkNonoPin(bin, env);
  if (!pin.ok) return refuse(`${pin.reason} — refusing to launch under an unpinned nono`);

  // (2) the profile must be loadable (S1b: validate-or-FAIL, never warn).
  const check = checkProfileLoadable(profile, bin, env);
  if (!check.ok) return refuse(`nono profile failed to load (${profile}): ${check.reason}`);

  // (3) the private dir: a root covered by NO grant this launch passes.
  const agentId = optionValue(cmd, "--id") ?? `launch-${process.pid}`;
  const priv = createPrivateLaunchDir({ home: opts.home ?? env.HOME, agentId, env });
  log.push(`priv=${priv.root}`);
  let server: Server | null = null;
  let child: ChildProcess | null = null;
  let reportedPid = 0;
  let sessionId: string | undefined;
  let childPid = 0;

  const killQuietly = (pid: number, signal: NodeJS.Signals = "SIGTERM") => {
    // NEVER pid 0 (the whole process group, including the launcher itself),
    // never our own pid, never a non-positive/non-finite value: a refused
    // launch must stop the session and the child, not the caller.
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) return;
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  };

  try {
    // (4a) the launcher's own ground truth: IT can read OUTSIDE, outside the
    // sandbox. If not, the canary is not a canary.
    const ownRead = readCanary(priv.outsideCanary);
    if (!("content" in ownRead) || ownRead.content !== priv.outsideNonce) {
      return refuse(
        `the launcher cannot read its own OUTSIDE canary ${priv.outsideCanary} ` +
          `(${canaryWire(ownRead)}) — without that ground truth the canary proves nothing`
      );
    }

    // (4b) the canary must be outside EVERY grant this launch passes.
    const grants = grantsOfOptions(options, [priv.sockDir]);
    const overlap = coveringGrant(priv.outsideCanary, grants);
    if (overlap) {
      return refuse(
        `the OUTSIDE canary ${priv.outsideCanary} is inside the grant '${overlap}' this launch ` +
          `passes — the private dir must sit at a root no grant covers (a naive mkdtemp under ` +
          `TMPDIR lands in the granted tmpdir)`
      );
    }

    // (5) listen BEFORE spawning: the child may connect the moment nono starts it.
    server = createServer();
    const listening = await listen(server, priv.sockPath);
    if (typeof listening === "string") return refuse(listening);

    // (6) spawn nono — async, keep P live; the launcher pins XDG_STATE_HOME so
    // the store `ps` reads is the store this session writes (never inherited).
    const args = buildNonoArgs(
      profile,
      { ...options, allow: [...(options.allow ?? []), priv.sockDir] },
      cmd,
      env
    );
    const spawnEnv: NodeJS.ProcessEnv = {
      ...sandboxChildEnv(env),
      XDG_STATE_HOME: priv.stateDir,
      [LAUNCH_SOCK_ENV]: priv.sockPath,
    };
    log.push(`spawn=${bin} ${args.join(" ")}`);
    child = spawn(bin, args, { stdio: "inherit", env: spawnEnv });
    const P = child.pid;
    if (!P) return refuse(`could not spawn ${bin}`);
    log.push(`nono_pid=${P}`);

    // (7) the handshake: the child's report, checked against nono's own view.
    const verdict = await new Promise<{ ok: boolean; reason?: string; session?: NonoSession; pid?: number }>(
      (resolveVerdict) => {
        const settled = { done: false };
        const finish = (v: { ok: boolean; reason?: string; session?: NonoSession; pid?: number }) => {
          if (settled.done) return;
          settled.done = true;
          resolveVerdict(v);
        };
        const window = opts.timeoutMs ?? timeoutMs(env);
        const timer = setTimeout(
          () => finish({ ok: false, reason: `no released child within ${window}ms` }),
          window
        );
        server!.on("connection", (conn: Socket) => {
          void decideConnection(conn, {
            P,
            profile: args[args.indexOf("--profile") + 1]!,
            priv,
            bin,
            env,
            failFirstSeam: opts.failFirstSeam,
          }).then((v) => {
            clearTimeout(timer);
            if (v.pid !== undefined) reportedPid = v.pid;
            if (v.ok && v.session && v.pid !== undefined) {
              // THE RELEASE. Written only here, only for a bound live session,
              // and it names the pid the child reported — the child requires
              // its own pid back, so a release minted for another pid is
              // useless to it.
              try {
                conn.write(`CONFINED ${v.session.session_id} ${v.pid}\n`);
              } catch {
                /* the child died first; the exit handler refuses the launch */
              }
            } else {
              conn.destroy();
            }
            finish(v);
          });
        });
        child!.on("exit", (code, signal) => {
          finish({
            ok: false,
            reason: `nono exited (${code ?? signal}) before the child was released`,
          });
        });
      }
    );

    if (!verdict.ok || !verdict.session || verdict.pid === undefined) {
      // Nothing is written; the child's bounded wait expires; the session and
      // the child are stopped; the private dir is removed in the finally block.
      killQuietly(verdict.pid ?? reportedPid);
      killQuietly(P);
      return refuse(`${verdict.reason} — refusing to release the agent`);
    }

    // (8) released: the release line was written above for this pid.
    sessionId = verdict.session.session_id;
    childPid = verdict.pid;
    log.push(`CONFINED ${sessionId} ${childPid}`);
    if (server) closeServer(server);
    console.error(
      `🔒 agent released under nono session ${sessionId} (child pid ${childPid}) — bound to the ` +
        `supervisor pid ${P} the launcher spawned`
    );

    // (9) post-release re-check: P alive and the session still running. A
    // session that died between the check and the release means the release was
    // not for a live sandbox. (Skipped under the in-process fails-first seam.)
    if (!pidAlive(P)) {
      killQuietly(childPid);
      return refuse(`the nono session's supervisor (${P}) died before the release was written`);
    }
    if (opts.failFirstSeam?.disablePidBinding) {
      return await exitCodeOf(child);
    }
    const recheck = psSessions(bin, priv, env);
    const still = findBoundSession(recheck, {
      supervisorPid: P,
      childPid,
      profile: args[args.indexOf("--profile") + 1]!,
    });
    if (!still.session) {
      killQuietly(childPid);
      killQuietly(P);
      return refuse(`the session stopped between the check and the release: ${still.reason}`);
    }

    // (10) the child runs; its exit code is the launch's.
    return await exitCodeOf(child);
  } finally {
    if (server) closeServer(server);
    removePrivateLaunchDir(priv);
    log.push(`cleaned=${!existsSync(priv.root)}`);
  }
}

/** Values of `--flag value` in a command line. */
function optionValue(cmd: readonly string[], flag: string): string | undefined {
  const i = cmd.indexOf(flag);
  return i >= 0 ? cmd[i + 1] : undefined;
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    /* already closed */
  }
}

function listen(server: Server, path: string): Promise<true | string> {
  return new Promise((resolvePromise) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolvePromise(`could not listen on ${path} (${err.code ?? err.message})`);
    });
    server.listen(path, () => resolvePromise(true));
  });
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise(child.exitCode);
    child.once("exit", (code, signal) => {
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}

/** `nono ps --all --json` with the launcher-pinned state root and the pinned
 * absolute binary. Never the inherited env: the store is the oracle's input. */
function psSessions(bin: string, priv: PrivateLaunchDir, env: NodeJS.ProcessEnv): NonoSession[] {
  const result = spawnSync(bin, ["ps", "-s", "--all", "--json"], {
    encoding: "utf-8",
    env: { ...env, XDG_STATE_HOME: priv.stateDir },
  });
  return parseNonoPs(`${result.stdout ?? ""}`);
}

/** Read the child's lines and decide. Exported for fixtures: the decision is
 * pure enough to drive with a scripted socket. */
export async function decideConnection(
  conn: Socket,
  ctx: {
    P: number;
    profile: string;
    priv: PrivateLaunchDir;
    bin: string;
    env: NodeJS.ProcessEnv;
    /** FAILS-FIRST SEAM, in-process only — see LaunchOptions. */
    failFirstSeam?: { disableCanaryCheck?: boolean; disablePidBinding?: boolean };
  }
): Promise<{ ok: boolean; reason?: string; session?: NonoSession; pid?: number }> {
  const window = timeoutMs(ctx.env);
  const reader = new LineReader(conn);
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    const line = await reader.next(window);
    if (typeof line !== "string") return { ok: false, reason: line.reason };
    lines.push(line.trim());
  }
  const pid = lines[0]!.match(/^PID (\d+)$/);
  if (!pid) return { ok: false, reason: `the child's first line was '${lines[0]}', not 'PID <pid>'` };
  const reportedPid = Number.parseInt(pid[1]!, 10);

  const outside = lines[1]!.match(/^CANARY OUTSIDE (\S+)$/);
  const inside = lines[2]!.match(/^CANARY INSIDE (\S+)$/);
  if (!outside || !inside) {
    return { ok: false, pid: reportedPid, reason: `unexpected canary lines: ${lines.slice(1).join(" | ")}` };
  }
  if (!ctx.failFirstSeam?.disableCanaryCheck) {
    if (outside[1] !== "DENIED") {
      return {
        ok: false,
        pid: reportedPid,
        reason:
          `the child READ the OUTSIDE canary ${ctx.priv.outsideCanary} (${outside[1]}) — it is ` +
          `not confined by the profile as launched`,
      };
    }
    if (inside[1] !== `READ:${ctx.priv.insideNonce}`) {
      return {
        ok: false,
        pid: reportedPid,
        reason:
          `the child did not read its granted twin correctly (${inside[1]} vs the launcher's nonce) ` +
          `— a blind DENIED is not evidence of a real read`,
      };
    }
  }
  if (!pidAlive(ctx.P)) {
    return { ok: false, pid: reportedPid, reason: `the pid the launcher spawned (${ctx.P}) is not alive` };
  }

  if (ctx.failFirstSeam?.disablePidBinding) {
    // The seam skips ONLY the binding; the release still has to be earned, so
    // the fixture that this seam is meant to green can go green.
    return {
      ok: true,
      pid: reportedPid,
      session: { session_id: "seam-no-binding", child_pid: reportedPid, status: "running" },
    };
  }

  const sessions = psSessions(ctx.bin, ctx.priv, ctx.env);
  const bound = findBoundSession(sessions, {
    supervisorPid: ctx.P,
    childPid: reportedPid,
    profile: ctx.profile,
  });
  if (!bound.session) return { ok: false, pid: reportedPid, reason: bound.reason };
  return { ok: true, session: bound.session, pid: reportedPid };
}

// Re-exported so a caller building a refusal message can name the same code.
export { EX_CONFIG };
