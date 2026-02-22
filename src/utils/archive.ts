/**
 * Communication archive — append-only JSONL log of all mail events.
 * 
 * Every send, read, and list operation appends one line to archive.jsonl.
 * This creates a searchable, complete audit trail of agent communication.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ArchiveEvent {
  event: "sent" | "read" | "listed";
  timestamp: string;
  from: string;
  to: string;
  messageId: string;
  bodyPreview?: string;
}

export interface ArchiveQuery {
  agent?: string;
  since?: string;
  until?: string;
  event?: "sent" | "read" | "listed";
  limit?: number;
}

function getArchivePath(): string {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  return join(dir, "archive.jsonl");
}

function makePreview(body: string, maxLen = 100): string {
  const firstLine = body.split("\n")[0] || "";
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;
}

/**
 * Append an event to the archive. Fire-and-forget — archive failures
 * never block mail operations.
 */
export function logEvent(event: Omit<ArchiveEvent, "timestamp">, body?: string): void {
  try {
    const entry: ArchiveEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    if (body) {
      entry.bodyPreview = makePreview(body);
    }
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(getArchivePath(), line, "utf-8");
  } catch {
    // Archive is best-effort. Never break mail for logging.
  }
}

/**
 * Query the archive with optional filters.
 * Reads the full file and filters in memory — fine for reasonable volumes.
 * For massive archives, we'd add rotation or indexing later.
 */
export function queryArchive(query: ArchiveQuery = {}): ArchiveEvent[] {
  const archivePath = getArchivePath();
  if (!existsSync(archivePath)) return [];

  const raw = readFileSync(archivePath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  let events: ArchiveEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as ArchiveEvent);
    } catch {
      // Skip malformed lines
    }
  }

  // Apply filters
  if (query.agent) {
    const a = query.agent;
    events = events.filter((e) => e.from === a || e.to === a);
  }
  if (query.event) {
    events = events.filter((e) => e.event === query.event);
  }
  if (query.since) {
    events = events.filter((e) => e.timestamp >= query.since!);
  }
  if (query.until) {
    events = events.filter((e) => e.timestamp <= query.until!);
  }

  // Sort newest first
  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  if (query.limit && query.limit > 0) {
    events = events.slice(0, query.limit);
  }

  return events;
}
