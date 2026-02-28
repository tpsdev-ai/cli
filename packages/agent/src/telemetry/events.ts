import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BaseEvent {
  ts: string;
  agent: string;
  session?: string;
  type: string;
}

export interface LLMRequestEvent extends BaseEvent {
  type: "llm.request";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  status: "ok" | "error" | "retry";
  error?: string;
  fallback?: boolean;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool.call";
  tool: string;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface CompactionEvent extends BaseEvent {
  type: "compaction";
  tokensBefore: number;
  tokensAfter: number;
  messagesDropped: number;
  memoryFlushed: boolean;
}

export interface MailEvent extends BaseEvent {
  type: "mail.send" | "mail.receive";
  from?: string;
  to?: string;
  subject?: string;
  durationMs?: number;
  status: "ok" | "error";
}

export interface SessionEvent extends BaseEvent {
  type: "session.start" | "session.end";
  model: string;
  contextTokens?: number;
}

export type TelemetryEvent =
  | LLMRequestEvent
  | ToolCallEvent
  | CompactionEvent
  | MailEvent
  | SessionEvent;

function dayStamp(ts: string): string {
  return ts.slice(0, 10);
}

export function sanitizeError(err: unknown): string {
  const raw = String((err as any)?.message ?? err ?? "unknown_error");
  return raw
    .replace(/(sk-[a-zA-Z0-9_-]+)/g, "[REDACTED_KEY]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 300);
}

export class EventLogger {
  constructor(
    private readonly agentId: string,
    private readonly baseDir: string,
  ) {
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private pathFor(ts: string): string {
    return join(this.baseDir, `events-${dayStamp(ts)}.jsonl`);
  }

  emit(event: any): void {
    const ts = event.ts || new Date().toISOString();
    const out = {
      ...(event as TelemetryEvent),
      agent: event.agent || this.agentId,
      ts,
    };

    const path = this.pathFor(ts);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(out)}\n`, "utf-8");
    if (!existsSync(path)) return;
    chmodSync(path, 0o600);
  }
}
