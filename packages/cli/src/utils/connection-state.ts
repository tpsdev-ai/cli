import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export interface HostStatePathListing {
  paths: string[];
  /** Set for a listing error other than ENOENT. */
  failure?: { path: string; code: string };
}

/** Connections directory `*.json` paths. A `host.json` object with neither
 *  `pid` nor `branch` is treated as branch state and skipped. A listing
 *  error other than ENOENT is reported. */
export function listHostStatePaths(): HostStatePathListing {
  const dir = connectionsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { paths: [] };
    return { paths: [], failure: { path: dir, code } };
  }
  return {
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

function branchStatePath(): string {
  return join(connectionsDir(), "host.json");
}

const HOST_STATE_LOCK_TIMEOUT_MS = 5000;

/** Root of the inter-process lock that owns one host state record. */
export function hostStateLockRoot(path: string): string {
  return `${path}.lock`;
}

/**
 * Hold one host state record's lock across a synchronous critical section.
 * `acquireMailLockSync` refuses nested acquisition and reclaims a dead owner;
 * a timeout is a refusal, never a proceed.
 */
export function withHostStateRecordLock<T>(path: string, action: string, fn: () => T): T {
  const root = hostStateLockRoot(path);
  const lockDir = mailLockPath(root);
  const lock = acquireMailLockSync(root, { timeoutMs: HOST_STATE_LOCK_TIMEOUT_MS });
  if (lock === null) {
    throw new Error(
      `Host state record lock ${lockDir} could not be acquired within ${HOST_STATE_LOCK_TIMEOUT_MS} ms; refusing to ${action}. The lock or its reclamation claim is held, or its owner could not be verified. Retry after any running tps command finishes; if none is running, remove ${root} and retry.`,
    );
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export function writeHostState(state: HostConnectionState, shouldWrite?: () => boolean): void {
  mkdirSync(connectionsDir(), { recursive: true, mode: 0o700 });
  const path = hostStatePath(state.branch);
  withHostStateRecordLock(path, "write the host state record", () => {
    // Checked inside the lock: a caller that has begun stop() sets its
    // flag before it takes the lock to clear, so a write it starts afterwards
    // is skipped.
    if (shouldWrite !== undefined && !shouldWrite()) return;
    writeFileSync(path, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  });
}

export function readHostState(branch: string): HostConnectionState | null {
  const p = hostStatePath(branch);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

/** True when the record still names this process: same pid, and the same
 *  start token when the record captured one. A record without a token compares
 *  by pid alone. */
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

/** Read a host state record and distinguish an absent file from one whose
 *  owner cannot be verified. A non-regular file (a directory or a symlink) and
 *  a parse or shape failure are reported, never treated as absent. */
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
    // A file removed between the two reads is absent; anything else is
    // unreadable.
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

/** Remove the record only when a final read under its lock still names this
 *  process. A record that names another process is left in place. A record
 *  that is present but unreadable or invalid is left in place and reported,
 *  because its owner cannot be verified. */
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

export function writeBranchState(state: BranchConnectionState): void {
  mkdirSync(connectionsDir(), { recursive: true });
  writeFileSync(branchStatePath(), JSON.stringify(state, null, 2), "utf-8");
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
