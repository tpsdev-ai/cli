import { homedir } from "node:os";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { workspacePath as resolveWorkspacePath } from "../utils/workspace.js";
import { readOpenClawConfig, resolveConfigPath, getAgentList, type OpenClawConfig, type OpenClawAgent } from "../utils/config.js";

const STATUS_DIR = join(process.env.HOME || homedir(), ".tps", "status");
const NODES_DIR = join(STATUS_DIR, "nodes");
const ARCHIVE_DIR = join(STATUS_DIR, "archive");
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_OFFLINE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_FILE_SIZE_LIMIT = 1024 * 1024; // 1MB

export type AgentState = "online" | "idle" | "error" | "offline" | "zombie" | "stale";

interface UsageEntry {
  ts: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface HeartbeatEvent {
  ts: string;
  status: AgentState;
  note?: string;
}

interface RawError {
  ts: string;
  reason: string;
}

interface NodeStatus {
  agentId: string;
  host: string;
  model: string;
  status: AgentState;
  lastHeartbeat: string;
  lastActivity: string;
  sessionCount: number;
  errorCount: number;
  uptime: number;
  version: string;
  pid: number;
  lastError?: string;
  workspace?: string;
  heartbeatHistory?: HeartbeatEvent[];
  errors?: RawError[];
  runtimeProfile?: string;
  nonono?: boolean;
}

export interface HeartbeatArgs {
  agentId: string;
  workspace?: string;
  configPath?: string;
  status?: AgentState;
  nonono?: boolean;
  profile?: string;
}

export interface StatusArgs {
  agentId?: string;
  json?: boolean;
  prune?: boolean;
  autoPrune?: boolean;
  staleMinutes?: number;
  offlineHours?: number;
  cost?: boolean;
  shared?: boolean;
  costSince?: "day" | "week" | "month";
}

interface RenderRow {
  id: string;
  state: AgentState;
  host: string;
  model: string;
  heartbeat: string;
  pid?: number;
  warning?: string;
}

function safeAgentDir(agentId: string): string {
  const safe = sanitizeIdentifier(agentId);
  if (!safe || safe !== sanitizeIdentifier(safe)) return "unknown";
  return safe;
}

function statusFilePath(agentId: string): string {
  const id = safeAgentDir(agentId);
  return join(NODES_DIR, `${id}.json`);
}

function usageFilePath(agentId: string): string {
  return join(NODES_DIR, safeAgentDir(agentId), "usage.jsonl");
}

function hostFingerprint(): string {
  return process.env.TPS_HOST_FINGERPRINT || process.env.HOSTNAME || "unknown-host";
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultModel(): string {
  return process.env.npm_package_version || "unknown";
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkWorkspaceWritable(agentWorkspace: string): string[] {
  const errs: string[] = [];
  try {
    const marker = join(agentWorkspace, `.tps-heartbeat-${Date.now()}.check`);
    writeFileSync(marker, "ok", "utf-8");
    writeFileSync(marker, "ok2", "utf-8");
    // clean best effort
    try {
      writeFileSync(marker, "ok", "utf-8");
    } catch {}
  } catch {
    errs.push("workspace write check failed");
  }
  return errs;
}

function checkGatewayHealth(): string[] {
  const check = spawnSync("openclaw", ["gateway", "status"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (check.status !== 0) {
    return ["gateway unreachable"];
  }
  return [];
}

function checkQueueAge(workspace: string): string[] {
  const inbox = join(workspace, "mail", "inbox", "new");
  if (!existsSync(inbox)) return [];

  const now = Date.now();
  const stale = readdirSync(inbox)
    .map((name) => join(inbox, name))
    .filter((path) => existsSync(path))
    .filter((path) => now - statSync(path).mtimeMs > 60 * 60 * 1000);

  if (stale.length > 0) {
    return ["unprocessed mail >1h old"];
  }
  return [];
}

function readStatus(agentId: string): NodeStatus | null {
  const file = statusFilePath(agentId);
  if (!existsSync(file)) return null;

  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as NodeStatus;
  } catch {
    return null;
  }
}

function writeStatus(agentId: string, payload: NodeStatus): void {
  ensureDir(NODES_DIR);
  ensureDir(join(NODES_DIR, safeAgentDir(agentId)));
  writeFileSync(statusFilePath(agentId), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function aggregateCost(usageEntries: UsageEntry[]): { today: number; week: number; month: number } {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const oneWeek = 7 * oneDay;
  const oneMonth = 31 * oneDay;

  return usageEntries.reduce(
    (acc, entry) => {
      const ts = new Date(entry.ts).getTime();
      const cost = Number(entry.estimatedCostUsd) || 0;
      if (Number.isNaN(ts)) return acc;
      const age = now - ts;
      if (age <= oneDay) acc.today += cost;
      if (age <= oneWeek) acc.week += cost;
      if (age <= oneMonth) acc.month += cost;
      return acc;
    },
    { today: 0, week: 0, month: 0 }
  );
}

function readUsageEntries(agentId: string): UsageEntry[] {
  const usagePath = usageFilePath(agentId);
  if (!existsSync(usagePath)) return [];
  try {
    const raw = readFileSync(usagePath, "utf-8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const out: UsageEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as UsageEntry);
      } catch {
        // ignore
      }
    }
    return out;
  } catch {
    return [];
  }
}

function rotateUsage(agentId: string): void {
  const usagePath = usageFilePath(agentId);
  if (!existsSync(usagePath)) return;
  if (statSync(usagePath).size <= STATUS_FILE_SIZE_LIMIT) return;

  const baseDir = join(NODES_DIR, safeAgentId(agentId));
  ensureDir(baseDir);

  for (let slot = 3; slot >= 1; slot--) {
    const src = slot === 1 ? `${usagePath}.1` : `${usagePath}.${slot - 1}`;
    const dst = `${usagePath}.${slot}`;
    if (existsSync(src)) {
      renameSync(src, dst);
    }
  }

  if (existsSync(usagePath)) {
    renameSync(usagePath, `${usagePath}.1`);
  }
}

function safeAgentId(agentId: string): string {
  const id = sanitizeIdentifier(agentId);
  return id || "unknown";
}

function resolveModel(agentId: string): string {
  const cfgPath = resolveConfigPath();
  if (!cfgPath) return "unknown-model";
  try {
    const cfg: OpenClawConfig = readOpenClawConfig(cfgPath);
    const list = getAgentList(cfg);
    const match = list.find((agent: OpenClawAgent) => agent.id === agentId);
    const direct = match?.model;
    if (typeof direct === "string") return direct;
    return "unknown-model";
  } catch {
    return "unknown-model";
  }
}

function detectDangerState(profile?: string, nonono?: boolean, status?: string): string {
  if (nonono) return "⚠️ nonono";
  if (profile && profile !== "tps-status") return "⚠️ custom profile";
  return "";
}

function computeState(raw: NodeStatus, now: number, staleMs: number, offlineMs: number): AgentState {
  const hb = new Date(raw.lastHeartbeat).getTime();
  if (raw.status === "error") {
    return "error";
  }
  if (raw.pid && raw.status === "online" && !isPidAlive(raw.pid)) {
    return "zombie";
  }
  if (now - hb >= offlineMs) return "offline";
  if (now - hb >= staleMs) return "stale";
  return raw.status || "idle";
}

function maybePrune(statusFiles: string[], now: number): void {
  ensureDir(ARCHIVE_DIR);
  for (const file of statusFiles) {
    const id = basename(file, ".json");
    const content = readStatus(id);
    if (!content?.lastHeartbeat) continue;
    if (now - new Date(content.lastHeartbeat).getTime() > DEFAULT_PRUNE_MS) {
      ensureDir(ARCHIVE_DIR);
      renameSync(file, join(ARCHIVE_DIR, `${id}.json`));
    }
  }
}

function listAgents(): string[] {
  if (!existsSync(NODES_DIR)) return [];
  return readdirSync(NODES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));
}

function parseArgsForCost(shared: boolean): Record<string, UsageEntry[]> {
  const out: Record<string, UsageEntry[]> = {};
  for (const agent of listAgents()) {
    out[agent] = readUsageEntries(agent);
  }

  if (!shared) return out;

  // shared mode groups by provider key; for v1 keep same key mapping by config model
  return out;
}

export async function runHeartbeat(args: HeartbeatArgs): Promise<void> {
  const agentId = safeAgentId(args.agentId);
  const workspace = args.workspace || resolveWorkspacePath(agentId);
  const previous = readStatus(agentId);
  const state: AgentState = "online";

  const checks: string[] = [];
  checks.push(...checkWorkspaceWritable(workspace));
  checks.push(...checkGatewayHealth());
  checks.push(...checkQueueAge(workspace));

  const now = nowIso();
  const nowMs = Date.now();
  const lastHeartbeat = new Date().toISOString();

  const prevHeartbeat = previous?.lastHeartbeat ? new Date(previous.lastHeartbeat).getTime() : nowMs;
  const uptime = previous?.uptime != null ? Number(previous.uptime) + Math.max(0, (nowMs - prevHeartbeat) / 1000) : 0;

  const lastError = checks.length ? checks[checks.length - 1] : undefined;
  const errors: RawError[] = previous?.errors ? [...previous.errors] : [];
  if (checks.length) {
    errors.push({ ts: now, reason: checks.join(",") });
  }

  const history: HeartbeatEvent[] = (previous?.heartbeatHistory || [])
    .filter((e): e is HeartbeatEvent => Boolean(e?.ts))
    .slice(-9);
  const resolvedState: AgentState = checks.length ? "error" : state;

  history.push({ ts: now, status: resolvedState, note: checks[0] });

  const status: NodeStatus = {
    agentId,
    host: hostFingerprint(),
    model: resolveModel(agentId),
    status: resolvedState,
    lastHeartbeat: lastHeartbeat,
    lastActivity: now,
    sessionCount: (previous?.sessionCount || 0) + 1,
    errorCount: errors.filter((entry) => nowMs - new Date(entry.ts).getTime() < 24 * 60 * 60 * 1000).length,
    uptime,
    version: defaultModel(),
    pid: process.pid,
    lastError,
    workspace,
    heartbeatHistory: history,
    errors,
    runtimeProfile: args.profile,
    nonono: !!args.nonono,
  };

  writeStatus(agentId, status);
  rotateUsage(agentId);

  if (resolvedState === "error") {
    console.log(`⚠️  Heartbeat for ${agentId}: error (${checks.join("; ")})`);
  } else {
    console.log(`✅ Heartbeat for ${agentId}: ${resolvedState}`);
  }
}

export async function runStatus(args: StatusArgs): Promise<void> {
  ensureDir(NODES_DIR);

  if (!args.agentId) {
    const now = Date.now();
    const staleMs = (args.staleMinutes || 30) * 60 * 1000;
    const offlineMs = (args.offlineHours || 2) * 60 * 60 * 1000;

    const statusPaths = readdirSync(NODES_DIR)
      .map((name) => join(NODES_DIR, name))
      .filter((name) => name.endsWith(".json") && existsSync(name));

    if (args.autoPrune) {
      maybePrune(statusPaths, now);
    }

    if (args.prune) {
      maybePrune(statusPaths, now);
      return;
    }

    const rows: RenderRow[] = statusPaths
      .map((p) => readStatus(basename(p, ".json")))
      .filter((r): r is NodeStatus => Boolean(r))
      .map((entry) => {
        const effective = computeState(entry, now, staleMs, offlineMs);
        const warning = detectDangerState(entry.runtimeProfile, entry.nonono);
        return {
          id: entry.agentId,
          state: effective,
          host: entry.host,
          model: entry.model,
          heartbeat: entry.lastHeartbeat,
          pid: entry.pid,
          warning,
        };
      });

    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log("No agents reported yet.");
      return;
    }

    const heading = [
      "agent",
      "state",
      "host",
      "model",
      "heartbeat",
      "pid",
      "warn",
    ].join("\t");
    console.log(heading);
    for (const row of rows) {
      console.log([
        row.id,
        row.state,
        row.host,
        row.model,
        row.heartbeat,
        row.pid ?? "-",
        row.warning ?? "",
      ].join("\t"));
    }
    return;
  }

  // Single-agent view
  const status = readStatus(args.agentId);
  if (!status) {
    console.error(`No status found for ${args.agentId}`);
    process.exit(1);
  }

  if (args.cost) {
    const usage = readUsageEntries(args.agentId);
    const cost = aggregateCost(usage);
    const report = {
      ...status,
      usage: {
        today: Number(cost.today.toFixed(4)),
        week: Number(cost.week.toFixed(4)),
        month: Number(cost.month.toFixed(4)),
        entries: usage.slice(-20),
      },
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.shared) {
    const all = parseArgsForCost(true);
    const total = Object.values(all)
      .flat()
      .reduce((sum, item) => sum + Number(item.estimatedCostUsd || 0), 0);
    console.log(JSON.stringify({ shared: { total: Number(total.toFixed(4)), providers: Object.keys(all).length } }, null, 2));
    return;
  }

  const staleMs = (args.staleMinutes || 30) * 60 * 1000;
  const offlineMs = (args.offlineHours || 2) * 60 * 60 * 1000;
  const effective = computeState(status, Date.now(), staleMs, offlineMs);
  const warning = detectDangerState(status.runtimeProfile, status.nonono);
  const payload = {
    ...status,
    derivedState: effective,
    warning,
    last10Heartbeats: (status.heartbeatHistory || []).slice(-10),
    recentErrors: (status.errors || []).slice(-10),
  };
  console.log(JSON.stringify(payload, null, 2));
}

export function writeUsageEntry(agentId: string, entry: UsageEntry): void {
  const safeAgent = safeAgentId(agentId);
  const usagePath = usageFilePath(safeAgent);
  const usageDir = join(NODES_DIR, safeAgent);
  ensureDir(usageDir);
  appendFileSync(usagePath, `${JSON.stringify(entry)}\n`, "utf-8");
  rotateUsage(safeAgent);
}
