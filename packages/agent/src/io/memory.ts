import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryEvent {
  type: string;
  ts: string;
  data: unknown;
}

/**
 * Append-only JSONL memory store. Each event is a line of JSON.
 * Provides a full audit trail of agent actions and LLM interactions.
 */
export class MemoryStore {
  constructor(public readonly memoryPath: string) {
    mkdirSync(dirname(memoryPath), { recursive: true });
  }

  append(event: MemoryEvent): void {
    const payload = this.sanitize(event);
    appendFileSync(this.memoryPath, JSON.stringify(payload) + "\n", "utf-8");
  }

  readAll(maxBytes = 1024 * 1024): MemoryEvent[] {
    if (!existsSync(this.memoryPath)) return [];

    const stat = statSync(this.memoryPath);
    if (stat.size === 0) return [];

    const size = Math.min(stat.size, maxBytes);
    const pos = Math.max(0, stat.size - size);

    const fd = openSync(this.memoryPath, "r");
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, pos);
    closeSync(fd);

    const content = buffer.toString("utf-8");
    const lines = content.split("\n");
    if (pos > 0) lines.shift();

    return lines
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEvent;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as MemoryEvent[];
  }

  /**
   * Scrub sensitive payloads so API keys never get persisted in memory.
   */
  private sanitize(event: MemoryEvent): MemoryEvent {
    const keys = this.sensitiveValues();
    const jsonString = JSON.stringify(event);
    let scrubbed = jsonString;

    for (const secret of keys) {
      if (!secret) continue;
      if (scrubbed.includes(secret)) {
        const token = this.mask(secret);
        scrubbed = scrubbed.split(secret).join(token);
      }
    }

    try {
      const parsed = JSON.parse(scrubbed);
      return parsed as MemoryEvent;
    } catch {
      return event;
    }
  }

  private sensitiveValues(): string[] {
    const interesting = [
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "OPENAI_API_KEY",
      "OLLAMA_HOST",
    ];

    const values = interesting
      .map((name) => process.env[name])
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return Array.from(new Set(values));
  }

  private mask(value: string): string {
    return `${value.slice(0, 3)}...${value.slice(-3)}[redacted]`;
  }

  /** Approximate token count kept for compat; use ContextManager for precise counts. */
  estimatedTokenCount(): number {
    if (!existsSync(this.memoryPath)) return 0;
    const stat = statSync(this.memoryPath);
    return Math.ceil(stat.size / 4);
  }
}
