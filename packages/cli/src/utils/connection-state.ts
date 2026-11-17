import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { acquireMailLockSync, mailLockPath, pidState, processStartToken } from "@tpsdev-ai/agent";
import { isPidRecordPid, isPidRecordStartToken } from "./pid-file.js";

const connectionsDir = () => join(process.env.HOME ?? homedir(), ".tps", "connections");

export interface ServiceHealth {
  name: string;
  status: "healthy" | "unhealthy" | "unknown";
  lastCheck: string | null;
  lastHealthy: string | null;
  error?: string;
}

export interface HostConnectionState {
  branch: string;
  connectedAt: string;
  lastHeartbeatSent: string;
  lastHeartbeatAck: string | null;
  reconnectCount: number;
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  pid: number;
  /** Process start token; absent from records written before it was captured. */
  startToken?: string | null;
  services?: ServiceHealth[];
  connectionId?: string;
}

export interface BranchConnectionState {
  connectedAt: string;
  lastSeen: string;
  messagesReceived: number;
  messagesPushed: number;
}

export function hostStatePath(branch: string): string {
  return join(connectionsDir(), `${branch}.json`);
}

/**
 * A `.<record>.<uuid>.tmp` name, the shape writeFileAtomic creates. The record
 * part is any non-empty name ending in `.json`; the trailing part is hex groups
 * in UUID layout.
 */
const TEMP_FILE_PATTERN = /^\..+\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * The age threshold for cleanup: an entry whose mtime is older than this is
 * treated as abandoned. This is a heuristic; a suspended writer or a clock
 * jump can cross the threshold while a write is still in progress.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

export interface ConnectionTempSweep {
  removed: string[];
  /** Entries the sweep reported instead of removing, with the reason. */
  left: { path: string; reason: string }[];
}

/**
 * Attempt to remove temp files left by a crash between creating the temp file
 * and renaming it. Only names matching the writer's temp shape are considered,
 * and removal is attempted for a matching regular file older than the threshold.
 * The inspection and the removal are separate steps:
 * an entry replaced with a symlink in between is removed as the link it became,
 * never followed. An entry that could not be inspected or removed is reported
 * in `left`; an entry already gone is in neither list.
 */
export function sweepStaleConnectionTemps(now = Date.now(), dir = connectionsDir()): ConnectionTempSweep {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { removed: [], left: [] };
    return { removed: [], left: [{ path: dir, reason: code }] };
  }
  const removed: string[] = [];
  const left: { path: string; reason: string }[] = [];
  for (const name of entries) {
    if (!TEMP_FILE_PATTERN.test(name)) continue;
    const path = join(dir, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      if (code !== "ENOENT") left.push({ path, reason: code });
      continue;
    }
    if (!stats.isFile()) {
      left.push({ path, reason: "not a regular file" });
      continue;
    }
    if (now - stats.mtimeMs <= STALE_TEMP_AGE_MS) continue;
    try {
      rmSync(path);
      removed.push(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      if (code !== "ENOENT") left.push({ path, reason: code });
    }
  }
  return { removed, left };
}

export interface HostStatePathListing {
  paths: string[];
  /** Set for a listing error other than ENOENT. */
  failure?: { path: string; code: string };
  tempCleanupLeft?: { path: string; reason: string }[];
}

/** Connections directory `*.json` paths. A `host.json` object with neither
 *  `pid` nor `branch` is treated as branch state and skipped. A listing
 *  error other than ENOENT is reported. */
export function listHostStatePaths(): HostStatePathListing {
  const dir = connectionsDir();
  const sweep = sweepStaleConnectionTemps();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { paths: [] };
    return { paths: [], failure: { path: dir, code } };
  }
  return {
    ...(sweep.left.length > 0 ? { tempCleanupLeft: sweep.left } : {}),
    paths: entries
      .filter((f) => {
        if (!f.endsWith(".json")) return false;
        if (f !== "host.json") return true;
        try {
          const state: unknown = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          return typeof state !== "object" || state === null || Array.isArray(state)
            || "pid" in state || "branch" in state;
        } catch {
          return true;
        }
      })
      .map((f) => join(dir, f)),
  };
}

/** Path of the branch connection state record. */
export function branchStatePath(): string {
  return join(connectionsDir(), "host.json");
}

const HOST_STATE_LOCK_TIMEOUT_MS = 5000;

/**
 * Write a file atomically: a uniquely named temp file in the same directory is
 * created exclusively with an existing regular record's observed permission
 * bits when one exists, else `mode`, written through its descriptor, synced,
 * and renamed over the target, so a write or rename failure leaves the
 * previous record intact. The parent directory sync after the rename is
 * best-effort: directory fsync is not supported everywhere, and the rename is
 * already atomic for readers. If a temp-file operation or rename throws, the
 * helper attempts to close any still-open descriptor and remove the temp file,
 * then rethrows the original error; cleanup errors are swallowed.
 */
function writeFileAtomic(filePath: string, content: string, mode: number): void {
  sweepStaleConnectionTemps(Date.now(), dirname(filePath));
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  // A regular record's observed permission bits are preserved; a symlinked
  // record is treated as absent, as before (the rename replaces the link with a
  // regular file).
  const existingMode = existingRecordMode(filePath);
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", existingMode ?? mode);
    if (existingMode !== undefined) {
      // fchmodSync restores the permission bits observed before the temp file
      // was opened (openSync applies the umask).
      fchmodSync(fd, existingMode);
    }
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
  // Best-effort only: directory fsync is not supported everywhere, and the
  // rename is already atomic for readers.
  try {
    const dirFd = openSync(dirname(filePath), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {}
}

/** The observed permission bits (0o777) of an existing regular record, or
 *  undefined when there is none. */
function existingRecordMode(filePath: string): number | undefined {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return undefined;
    // An unreadable record must not be replaced with a broader default.
    throw error;
  }
  if (!stats.isFile()) return undefined;
  return stats.mode & 0o777;
}

/** Root of the inter-process lock that owns one host state record. */
export function hostStateLockRoot(path: string): string {
  return `${path}.lock`;
}

/**
 * Hold one host state record's lock across a synchronous critical section.
 * `acquireMailLockSync` refuses nested acquisition and reclaims a dead owner;
 * a timeout is a refusal, never a proceed.
 */
export function withHostStateRecordLock<T>(path: string, action: string, fn: () => T, timeoutMs = HOST_STATE_LOCK_TIMEOUT_MS): T {
  const root = hostStateLockRoot(path);
  const lockDir = mailLockPath(root);
  const lock = acquireMailLockSync(root, { timeoutMs });
  if (lock === null) {
    throw new Error(
      `Host state record lock ${lockDir} could not be acquired within ${timeoutMs} ms; refusing to ${action}. The lock or its reclamation claim is held, or its owner could not be verified. Retry after any running tps command finishes; if none is running, remove ${root} and retry.`,
    );
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export function writeHostState(state: HostConnectionState, shouldWrite?: () => boolean, timeoutMs = HOST_STATE_LOCK_TIMEOUT_MS): void {
  writeHostStateAt(hostStatePath(state.branch), state, shouldWrite, timeoutMs);
}

export function writeHostStateAt(path: string, state: HostConnectionState, shouldWrite?: () => boolean, timeoutMs = HOST_STATE_LOCK_TIMEOUT_MS): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withHostStateRecordLock(path, "write the host state record", () => {
    // Checked inside the lock: a caller that has begun stop() sets its
    // flag before it takes the lock to clear, so a write it starts afterwards
    // is skipped.
    if (shouldWrite !== undefined && !shouldWrite()) return;
    writeFileAtomic(path, JSON.stringify(state, null, 2), 0o600);
  }, timeoutMs);
}

/** IN-PROCESS test seam only: no command, flag or environment variable reaches
 *  it. Production callers use the default start-token reader. */
export interface HostStateReadHooks {
  startToken?: (pid: number) => string | null;
}

/** What a refresh or claim did under the record lock. `unverifiable` means
 *  ownership is neither confirmed nor denied (a token that cannot be read, or
 *  another owner's liveness that cannot be decided); nothing is written. */
export type HostStateRefreshOutcome =
  | { kind: "written" }
  | { kind: "stopped" }
  | { kind: "absent" }
  | { kind: "other" }
  | { kind: "unverifiable" }
  | { kind: "invalid" }
  | { kind: "unreadable"; reason: string };

/**
 * Refresh a record this connection still owns. Under the record lock the
 * record is read and written when the optional `shouldWrite` gate holds and
 * ownership matches: an absent record or one owned by another connection is
 * left alone (never recreated or replaced), and an invalid, unreadable or
 * unverifiable record is left as it is. Returns what happened.
 */
export function refreshOwnedHostStateAt(path: string, state: HostConnectionState, connectionId: string, shouldWrite?: () => boolean, timeoutMs = HOST_STATE_LOCK_TIMEOUT_MS, hooks?: HostStateReadHooks): HostStateRefreshOutcome {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withHostStateRecordLock(path, "write the host state record", (): HostStateRefreshOutcome => {
    if (shouldWrite !== undefined && !shouldWrite()) return { kind: "stopped" };
    const ownership = hostRecordOwnership(path, state.branch, connectionId, hooks?.startToken);
    if (ownership.kind !== "owned") return ownership;
    writeFileAtomic(path, JSON.stringify(state, null, 2), 0o600);
    return { kind: "written" };
  }, timeoutMs);
}

/**
 * Claim a record for a connection that has established before. Under the
 * record lock, while the optional `shouldWrite` gate holds, read the record and
 * attempt the write when it is absent, is verified as owned by this connection,
 * or belongs to a connection whose recorded process is not running or carries
 * a different `proc:` token (pid reuse). `ps:` mismatches are unverifiable:
 * their text depends on the reader's TZ and locale. Filesystem failure can throw.
 * An invalid, unreadable or unverifiable record is left as it is.
 * The absent case differs from a refresh: a reconnect may re-establish a record
 * that was removed.
 */
export function claimHostStateAt(path: string, state: HostConnectionState, connectionId: string, shouldWrite?: () => boolean, timeoutMs = HOST_STATE_LOCK_TIMEOUT_MS, hooks?: HostStateReadHooks): HostStateRefreshOutcome {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withHostStateRecordLock(path, "write the host state record", (): HostStateRefreshOutcome => {
    if (shouldWrite !== undefined && !shouldWrite()) return { kind: "stopped" };
    const ownership = claimableHostRecordOwnership(path, state.branch, connectionId, hooks?.startToken);
    if (ownership.kind !== "absent" && ownership.kind !== "claimable") return ownership;
    writeFileAtomic(path, JSON.stringify(state, null, 2), 0o600);
    return { kind: "written" };
  }, timeoutMs);
}

/** "same" for the same PID, and the same start token when one is present;
 *  "unverifiable" when the record carries a token this process cannot read. */
function selfIdentity(state: HostConnectionState, readStartToken: (pid: number) => string | null = processStartToken): "same" | "other" | "unverifiable" {
  if (state.pid !== process.pid) return "other";
  if (state.startToken === undefined || state.startToken === null) return "same";
  const ownToken = readStartToken(process.pid);
  if (ownToken === null) return "unverifiable";
  return state.startToken === ownToken ? "same" : "other";
}

type HostRecordRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "invalid" }
  | { kind: "record"; state: HostConnectionState };

function readHostRecord(path: string, branch: string): HostRecordRead {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: `could not be inspected (${code})` };
  }
  if (!isFile) return { kind: "unreadable", reason: "is not a regular file" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: `could not be read (${code})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "invalid" };
  const state = parsed as Record<string, unknown>;
  if (state.branch !== branch
    || typeof state.connectedAt !== "string"
    || typeof state.lastHeartbeatSent !== "string"
    || (state.lastHeartbeatAck !== null && typeof state.lastHeartbeatAck !== "string")
    || typeof state.reconnectCount !== "number"
    || typeof state.bytesSent !== "number"
    || typeof state.bytesReceived !== "number"
    || typeof state.messagesSent !== "number"
    || typeof state.messagesReceived !== "number"
    || !isPidRecordPid(state.pid)
    || !isPidRecordStartToken(state.startToken)
    || (state.connectionId !== undefined && (typeof state.connectionId !== "string" || state.connectionId.length === 0))
    || (state.services !== undefined && (!Array.isArray(state.services) || !state.services.every((service: unknown) => {
      if (typeof service !== "object" || service === null || Array.isArray(service)) return false;
      const health = service as Record<string, unknown>;
      return typeof health.name === "string"
        && (health.status === "healthy" || health.status === "unhealthy" || health.status === "unknown")
        && (health.lastCheck === null || typeof health.lastCheck === "string")
        && (health.lastHealthy === null || typeof health.lastHealthy === "string")
        && (health.error === undefined || typeof health.error === "string");
    })))) return { kind: "invalid" };
  return { kind: "record", state: parsed as HostConnectionState };
}

type HostRecordOwnership =
  | { kind: "owned" }
  | { kind: "absent" }
  | { kind: "other" }
  | { kind: "unverifiable" }
  | { kind: "invalid" }
  | { kind: "unreadable"; reason: string };

/**
 * Read the record first; return absent, invalid or unreadable before checking
 * ownership. A supplied connection id must match before process identity is
 * checked. Removal and the owned write both use this rule.
 */
function hostRecordOwnership(path: string, branch: string, connectionId?: string, readStartToken?: (pid: number) => string | null): HostRecordOwnership {
  const current = readHostRecord(path, branch);
  if (current.kind === "absent") return { kind: "absent" };
  if (current.kind === "invalid") return { kind: "invalid" };
  if (current.kind === "unreadable") return { kind: "unreadable", reason: current.reason };
  if (connectionId !== undefined && current.state.connectionId !== connectionId) return { kind: "other" };
  const identity = selfIdentity(current.state, readStartToken);
  if (identity === "unverifiable") return { kind: "unverifiable" };
  if (identity === "other") return { kind: "other" };
  return { kind: "owned" };
}

type OwnerLiveness = "alive" | "gone" | "unknown";

/** The source component of a birth token (`proc:` / `ps:`), or the whole string. */
function tokenSource(token: string): string {
  const i = token.indexOf(":");
  return i === -1 ? token : token.slice(0, i);
}

/**
 * Whether the process that wrote a record is still the one running under its
 * pid. "gone": the pid is gone, or a live pid carries a different `proc:`
 * token (pid reuse). A changed `proc:` record token is indistinguishable from
 * pid reuse. A live `ps:` mismatch is unknown because its text depends on the
 * reader's TZ and locale. Missing, unreadable or different-source tokens are
 * also unknown; unknown never licenses a write.
 */
function ownerLiveness(state: HostConnectionState, readStartToken: (pid: number) => string | null = processStartToken): OwnerLiveness {
  const pid = pidState(state.pid);
  if (pid === "gone") return "gone";
  if (pid === "invalid") return "unknown";
  if (state.startToken === undefined || state.startToken === null) return "unknown";
  let liveToken: string | null;
  try {
    liveToken = readStartToken(state.pid);
  } catch {
    return "unknown";
  }
  if (liveToken === null) return "unknown";
  if (tokenSource(liveToken) !== tokenSource(state.startToken)) return "unknown";
  if (liveToken === state.startToken) return "alive";
  return tokenSource(liveToken) === "proc" ? "gone" : "unknown";
}

type HostRecordClaim =
  | { kind: "claimable" }
  | { kind: "absent" }
  | { kind: "other" }
  | { kind: "unverifiable" }
  | { kind: "invalid" }
  | { kind: "unreadable"; reason: string };

/**
 * Ownership for a reconnect claim: the rule in `hostRecordOwnership`, plus a
 * record owned by another connection is claimable when its recorded process is
 * not running or carries a different `proc:` token (pid reuse). `ps:` mismatches
 * are unverifiable because their text depends on the reader's TZ and locale.
 * The read and the liveness check run under the caller's record
 * lock, so the evidence and the write share one hold.
 */
function claimableHostRecordOwnership(path: string, branch: string, connectionId: string, readStartToken?: (pid: number) => string | null): HostRecordClaim {
  const current = readHostRecord(path, branch);
  if (current.kind === "absent") return { kind: "absent" };
  if (current.kind === "invalid") return { kind: "invalid" };
  if (current.kind === "unreadable") return { kind: "unreadable", reason: current.reason };
  const ownership = connectionId !== undefined && current.state.connectionId !== connectionId
    ? "other"
    : selfIdentity(current.state, readStartToken);
  if (ownership === "same") return { kind: "claimable" };
  if (ownership === "unverifiable") return { kind: "unverifiable" };
  const liveness = ownerLiveness(current.state, readStartToken);
  if (liveness === "gone") return { kind: "claimable" };
  return liveness === "unknown" ? { kind: "unverifiable" } : { kind: "other" };
}

export function clearHostState(branch: string): void {
  clearHostStateAt(hostStatePath(branch), branch);
}

/** Records classified as unreadable, invalid or unverifiable by the locked
 *  read are kept and reported. */
export function clearHostStateAt(path: string, branch: string, connectionId?: string, hooks?: HostStateReadHooks): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withHostStateRecordLock(path, "remove the host state record", () => {
    const ownership = hostRecordOwnership(path, branch, connectionId, hooks?.startToken);
    if (ownership.kind === "absent" || ownership.kind === "other") return;
    if (ownership.kind !== "owned") {
      const reason = ownership.kind === "invalid"
        ? "is not a valid host state record"
        : ownership.kind === "unverifiable"
          ? "this process's start token could not be read"
          : ownership.reason;
      throw new Error(
        `Host state record ${path} is present but ${reason}, so its owner cannot be verified; the record was kept. Inspect it and remove it if no connector for that host is running.`,
      );
    }
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // ENOENT is already gone; any other failure is reported to the caller.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
}

/** Write the branch connection state record atomically; a write or rename
 *  failure throws. The parent directory sync after the rename is best-effort,
 *  so its failure is ignored. */
export function writeBranchState(state: BranchConnectionState): void {
  mkdirSync(connectionsDir(), { recursive: true });
  writeFileAtomic(branchStatePath(), JSON.stringify(state, null, 2), 0o666);
}

export function clearBranchState(): void {
  try { rmSync(branchStatePath(), { force: true }); } catch {}
}
