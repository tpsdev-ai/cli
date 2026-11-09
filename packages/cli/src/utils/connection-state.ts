import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { acquireMailLockSync, mailLockPath, pidState, processStartToken, type PidState } from "@tpsdev-ai/agent";
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
  /** Matching entries the sweep did not remove, with the reason; on a directory read error other than ENOENT, the directory path. */
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
export function sweepStaleConnectionTemps(now = Date.now()): ConnectionTempSweep {
  const dir = connectionsDir();
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
  /** Matching temp entries that could not be inspected or removed. A directory read error is reported in `failure`, not here. */
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
  sweepStaleConnectionTemps();
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
  mkdirSync(connectionsDir(), { recursive: true, mode: 0o700 });
  const path = hostStatePath(state.branch);
  withHostStateRecordLock(path, "write the host state record", () => {
    // Checked inside the lock: a caller that has begun stop() sets its
    // flag before it takes the lock to clear, so a write it starts afterwards
    // is skipped.
    if (shouldWrite !== undefined && !shouldWrite()) return;
    writeFileAtomic(path, JSON.stringify(state, null, 2), 0o600);
  }, timeoutMs);
}

export function readHostState(branch: string): HostConnectionState | null {
  const p = hostStatePath(branch);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

/** True for the same PID, and the same start token when one is present. */
function recordNamesOwnProcess(state: HostConnectionState): boolean {
  if (state.pid !== process.pid) return false;
  if (state.startToken === undefined || state.startToken === null) return true;
  return state.startToken === processStartToken(process.pid);
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

/** Records classified as unreadable or invalid by the locked read are kept and reported. */
export function clearHostState(branch: string): void {
  mkdirSync(connectionsDir(), { recursive: true, mode: 0o700 });
  const path = hostStatePath(branch);
  withHostStateRecordLock(path, "remove the host state record", () => {
    const current = readHostRecord(path, branch);
    if (current.kind === "absent") return;
    if (current.kind !== "record") {
      throw new Error(
        `Host state record ${path} is present but ${current.kind === "invalid" ? "is not a valid host state record" : current.reason}, so its owner cannot be verified; the record was kept. Inspect it and remove it if no connector for that host is running.`,
      );
    }
    if (!recordNamesOwnProcess(current.state)) return;
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

export function readBranchState(): BranchConnectionState | null {
  const p = branchStatePath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function clearBranchState(): void {
  try { rmSync(branchStatePath(), { force: true }); } catch {}
}

export function connectionAlive(branch: string, probe: (pid: number) => PidState = pidState): boolean | null {
  const state = readHostState(branch);
  if (!state) return null;
  return probe(state.pid) === "alive";
}
