import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { createFlairClient, defaultFlairKeyPath, type FlairAgent } from "../utils/flair-client.js";

const DEFAULT_INTERVAL_SECONDS = 60;
const STALE_MS = 5 * 60 * 1000;
const CURSOR_DIR = join(process.env.HOME || homedir(), ".tps", "cursors");
const STATE_DIR = join(process.env.HOME || homedir(), ".tps", "office-health");
const STATE_PATH = join(STATE_DIR, "state.json");

export interface OfficeHealthArgs {
  interval?: number;
  json?: boolean;
  viewerId?: string;
  flairUrl?: string;
  keyPath?: string;
  once?: boolean;
}

export interface HealthState {
  unhealthyAgents: Record<string, { active: boolean; firstDetectedAt?: string; lastPublishedAt?: string }>;
}

interface AgentHealthIssue {
  code: "heartbeat_stale" | "task_cursor_stale";
  summary: string;
  detail: string;
  ageMs: number;
}

export interface AgentHealthRecord {
  agentId: string;
  heartbeatAgeMs: number | null;
  taskCursorAgeMs: number | null;
  stale: boolean;
  issues: AgentHealthIssue[];
  eventPublished: boolean;
}

export interface OfficeHealthTickResult {
  timestamp: string;
  viewerId: string;
  checkedAgents: number;
  staleAgents: number;
  publishedEvents: number;
  agents: AgentHealthRecord[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireAgentId(value: string | undefined, label: string): string {
  if (!value) fail(`Invalid ${label}: missing`);
  const safe = sanitizeIdentifier(value);
  if (safe !== value) fail(`Invalid ${label}: ${value}`);
  return value;
}

function normalizeIntervalSeconds(interval?: number): number {
  if (interval === undefined) return DEFAULT_INTERVAL_SECONDS;
  if (!Number.isFinite(interval) || interval <= 0) {
    fail(`--interval must be a positive number of seconds. Got: ${interval}`);
  }
  return interval;
}

function readState(): HealthState {
  if (!existsSync(STATE_PATH)) return { unhealthyAgents: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as HealthState;
    return { unhealthyAgents: parsed.unhealthyAgents ?? {} };
  } catch {
    return { unhealthyAgents: {} };
  }
}

function writeState(state: HealthState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function ageMsFromIso(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, nowMs - ts);
}

function ageMsFromPath(path: string, nowMs: number): number | null {
  if (!existsSync(path)) return null;
  try {
    return Math.max(0, nowMs - statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "missing";
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

function cursorPath(agentId: string): string {
  return join(CURSOR_DIR, `${agentId}-task-loop.json`);
}

function buildIssues(agent: FlairAgent, nowMs: number): Omit<AgentHealthRecord, "eventPublished"> {
  const heartbeatAgeMs = ageMsFromIso(agent.lastHeartbeat, nowMs);
  const taskCursorAgeMs = ageMsFromPath(cursorPath(agent.id), nowMs);
  const issues: AgentHealthIssue[] = [];

  if (heartbeatAgeMs !== null && heartbeatAgeMs > STALE_MS) {
    issues.push({
      code: "heartbeat_stale",
      summary: `heartbeat stale (${formatAge(heartbeatAgeMs)})`,
      detail: `lastHeartbeat=${agent.lastHeartbeat}`,
      ageMs: heartbeatAgeMs,
    });
  }

  if (taskCursorAgeMs !== null && taskCursorAgeMs > STALE_MS) {
    issues.push({
      code: "task_cursor_stale",
      summary: `task cursor stale (${formatAge(taskCursorAgeMs)})`,
      detail: `cursorPath=${cursorPath(agent.id)}`,
      ageMs: taskCursorAgeMs,
    });
  }

  return {
    agentId: agent.id,
    heartbeatAgeMs,
    taskCursorAgeMs,
    stale: issues.length > 0,
    issues,
  };
}

function renderText(result: OfficeHealthTickResult): string {
  const healthy = result.checkedAgents - result.staleAgents;
  const staleList = result.agents
    .filter((agent) => agent.stale)
    .map((agent) => `${agent.agentId}[${agent.issues.map((issue) => issue.summary).join(", ")}]`)
    .join("; ");
  return [
    `[${result.timestamp}] checked=${result.checkedAgents} healthy=${healthy} stale=${result.staleAgents} published=${result.publishedEvents}`,
    staleList ? `stale: ${staleList}` : "stale: none",
  ].join("\n");
}

export async function runOfficeHealthTick(args: {
  viewerId: string;
  flairUrl?: string;
  keyPath?: string;
  nowMs?: number;
  state?: HealthState;
}): Promise<{ result: OfficeHealthTickResult; state: HealthState }> {
  const nowMs = args.nowMs ?? Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const flair = createFlairClient(args.viewerId, args.flairUrl, args.keyPath ?? defaultFlairKeyPath(args.viewerId));
  const agents = await flair.listAgents();
  const nextState: HealthState = args.state ?? readState();
  let publishedEvents = 0;

  const records: AgentHealthRecord[] = [];
  for (const agent of agents) {
    if (!agent?.id) continue;
    const record = buildIssues(agent, nowMs);
    const prior = nextState.unhealthyAgents[agent.id];
    let eventPublished = false;

    if (record.stale) {
      const summary = `${agent.id} unhealthy: ${record.issues.map((issue) => issue.summary).join(", ")}`;
      const detail = record.issues
        .map((issue) => `${issue.summary}; ${issue.detail}`)
        .join("\n");

      if (!prior?.active) {
        await flair.publishEvent({
          kind: "agent.unhealthy",
          summary,
          detail,
          targetIds: [agent.id],
        });
        publishedEvents += 1;
        eventPublished = true;
      }

      nextState.unhealthyAgents[agent.id] = {
        active: true,
        firstDetectedAt: prior?.firstDetectedAt ?? timestamp,
        lastPublishedAt: eventPublished ? timestamp : prior?.lastPublishedAt,
      };
    } else {
      nextState.unhealthyAgents[agent.id] = { active: false };
    }

    records.push({ ...record, eventPublished });
  }

  const result: OfficeHealthTickResult = {
    timestamp,
    viewerId: args.viewerId,
    checkedAgents: records.length,
    staleAgents: records.filter((record) => record.stale).length,
    publishedEvents,
    agents: records.sort((a, b) => a.agentId.localeCompare(b.agentId)),
  };

  return { result, state: nextState };
}

export async function runOfficeHealth(args: OfficeHealthArgs): Promise<void> {
  const viewerId = requireAgentId(args.viewerId ?? process.env.TPS_AGENT_ID ?? "anvil", "viewer id");
  const intervalSeconds = normalizeIntervalSeconds(args.interval);
  let state = readState();
  let stop = false;
  let wake: (() => void) | null = null;

  const handleSignal = () => {
    stop = true;
    if (wake) {
      wake();
      wake = null;
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    do {
      const tick = await runOfficeHealthTick({
        viewerId,
        flairUrl: args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926",
        keyPath: args.keyPath ?? defaultFlairKeyPath(viewerId),
        state,
      });
      state = tick.state;
      writeState(state);

      if (args.json) console.log(JSON.stringify(tick.result));
      else console.log(renderText(tick.result));

      if (args.once || stop) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, intervalSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    } while (!stop);
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}
