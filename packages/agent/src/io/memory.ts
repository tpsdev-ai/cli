import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryEvent {
  type: string;
  ts: string;
  data: unknown;
}

/**
 * Append-only JSONL memory store. Each event is a line of JSON.
 * Provides full audit trail of agent actions and LLM interactions.
 */
export class MemoryStore {
  constructor(public readonly memoryPath: string) {
    mkdirSync(dirname(memoryPath), { recursive: true });
  }

  append(event: MemoryEvent): void {
    appendFileSync(this.memoryPath, JSON.stringify(event) + "\n", "utf-8");
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
    if (pos > 0) lines.shift(); // drop partial first line
    
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

  /** Count approximate token length (4 chars ≈ 1 token) */
  estimatedTokenCount(): number {
    if (!existsSync(this.memoryPath)) return 0;
    const stat = statSync(this.memoryPath);
    return Math.ceil(stat.size / 4);
  }
}
