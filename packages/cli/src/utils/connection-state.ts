import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pidState, type PidState } from "@tpsdev-ai/agent";

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

export function writeHostState(state: HostConnectionState): void {
  mkdirSync(connectionsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(hostStatePath(state.branch), JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function readHostState(branch: string): HostConnectionState | null {
  const p = hostStatePath(branch);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function clearHostState(branch: string): void {
  try { rmSync(hostStatePath(branch), { force: true }); } catch {}
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

/** A record file that exists but could not be included in a listing. */
export interface HostStateProblem {
  path: string;
  reason: "unreadable" | "unparseable";
  /** Errno code for an unreadable record. */
  code?: string;
}

export interface HostStateListing {
  states: HostConnectionState[];
  /** Record files that exist but could not be read or parsed. */
  problems: HostStateProblem[];
}

/** A connections directory that cannot be listed for a reason other than
 *  ENOENT. A missing directory is an empty listing; this error carries the
 *  path and code so a caller can report the failed read. */
export class ConnectionsDirectoryError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, code: string) {
    super(
      `Connections directory ${path} could not be read (${code}). Check that the path is a readable directory; repair or remove it, then try again.`,
    );
    this.name = "ConnectionsDirectoryError";
    this.path = path;
    this.code = code;
  }
}

/** Host state records with a per-record problem list. A missing directory
 *  (ENOENT) is an empty listing; any other readdir failure is thrown as a
 *  ConnectionsDirectoryError naming the path and code. A host state record
 *  file (`*.json` other than `host.json`) that cannot be read or parsed is
 *  reported in `problems`, not dropped. */
export function listHostStates(): HostStateListing {
  const dir = connectionsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { states: [], problems: [] };
    throw new ConnectionsDirectoryError(dir, code);
  }

  const listing: HostStateListing = { states: [], problems: [] };
  for (const f of entries) {
    if (!f.endsWith(".json") || f === "host.json") continue;
    const path = join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      listing.problems.push({
        path,
        reason: "unreadable",
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      listing.problems.push({ path, reason: "unparseable" });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      listing.problems.push({ path, reason: "unparseable" });
      continue;
    }
    listing.states.push(parsed as HostConnectionState);
  }
  return listing;
}

export function connectionAlive(branch: string, probe: (pid: number) => PidState = pidState): boolean | null {
  const state = readHostState(branch);
  if (!state) return null;
  return probe(state.pid) === "alive";
}
