import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { createFlairClient, type OrgEvent } from "../utils/flair-client.js";

export interface AgentLogsArgs {
  agentId?: string;
  asAgent?: string;
  flairUrl?: string;
  keyPath?: string;
  mailDir?: string;
  limit?: number;
  json?: boolean;
}

interface TimelineItem {
  source: "flair" | "mail";
  kind: string;
  summary: string;
  timestamp: string;
}

interface MailRecord {
  timestamp?: string;
  body?: string;
  headers?: Record<string, string>;
}

const DEFAULT_LIMIT = 20;
const KIND_WIDTH = 18;

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

function normalizeLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    fail(`--limit must be a positive integer. Got: ${limit}`);
  }
  return limit;
}

function summarizeMail(record: MailRecord): string {
  const headerSubject = record.headers?.subject ?? record.headers?.Subject;
  if (typeof headerSubject === "string" && headerSubject.trim()) {
    return headerSubject.trim();
  }
  const firstLine = (record.body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? "(no subject)";
}

function readMailTimeline(mailDir: string, agentId: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  const mailboxRoot = join(mailDir, agentId);
  for (const folder of ["new", "cur"] as const) {
    const dir = join(mailboxRoot, folder);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(dir, entry), "utf-8");
        const parsed = JSON.parse(raw) as MailRecord;
        if (!parsed.timestamp) continue;
        items.push({
          source: "mail",
          kind: "mail",
          summary: summarizeMail(parsed),
          timestamp: parsed.timestamp,
        });
      } catch {
        // Ignore malformed mail entries so one bad file does not break the log view.
      }
    }
  }
  return items;
}

function filterRelevantEvents(events: OrgEvent[], agentId: string): TimelineItem[] {
  return events
    .filter((event) => event.authorId === agentId || event.targetIds?.includes(agentId))
    .map((event) => ({
      source: "flair" as const,
      kind: event.kind,
      summary: event.summary,
      timestamp: event.createdAt,
    }));
}

function compareDesc(a: TimelineItem, b: TimelineItem): number {
  return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

function relativeTime(timestamp: string, now = Date.now()): string {
  const diffMs = Math.max(0, now - Date.parse(timestamp));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatLine(item: TimelineItem): string {
  return `${relativeTime(item.timestamp).padEnd(8)}  ${item.kind.padEnd(KIND_WIDTH)}  ${item.summary}`;
}

export async function runAgentLogs(args: AgentLogsArgs): Promise<void> {
  const agentId = requireAgentId(args.agentId, "agent id");
  const viewerId = requireAgentId(args.asAgent ?? process.env.TPS_AGENT_ID, "viewer id");
  const limit = normalizeLimit(args.limit);
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const mailDir = args.mailDir ?? process.env.TPS_MAIL_DIR ?? join(homedir(), ".tps", "mail");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const keyPath = args.keyPath ?? join(homedir(), ".tps", "identity", `${viewerId}.key`);
  const flair = createFlairClient(viewerId, flairUrl, keyPath);
  const [events, mail] = await Promise.all([
    flair.getEventsSince(agentId, since),
    Promise.resolve(readMailTimeline(mailDir, agentId)),
  ]);

  const combined = [...filterRelevantEvents(events, agentId), ...mail]
    .sort(compareDesc)
    .slice(0, limit);

  if (args.json) {
    console.log(JSON.stringify(combined, null, 2));
    return;
  }

  for (const item of combined) {
    console.log(formatLine(item));
  }
}
