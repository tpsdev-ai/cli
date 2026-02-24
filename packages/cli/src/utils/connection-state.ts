import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const connectionsDir = () => join(process.env.HOME ?? homedir(), ".tps", "connections");

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
}

export interface BranchConnectionState {
  connectedAt: string;
  lastSeen: string;
  messagesReceived: number;
  messagesPushed: number;
}

function hostStatePath(branch: string): string {
  return join(connectionsDir(), `${branch}.json`);
}

function branchStatePath(): string {
  return join(connectionsDir(), "host.json");
}

export function writeHostState(state: HostConnectionState): void {
  mkdirSync(connectionsDir(), { recursive: true });
  writeFileSync(hostStatePath(state.branch), JSON.stringify(state, null, 2), "utf-8");
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

export function listHostStates(): HostConnectionState[] {
  const dir = connectionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "host.json")
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf-8")) as HostConnectionState; } catch { return null; }
    })
    .filter((x): x is HostConnectionState => !!x);
}

export function connectionAlive(branch: string): boolean | null {
  const state = readHostState(branch);
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}
