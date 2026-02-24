import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

  readAll(): MemoryEvent[] {
    if (!existsSync(this.memoryPath)) return [];
    return readFileSync(this.memoryPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryEvent);
  }

  /** Count approximate token length (4 chars ≈ 1 token) */
  estimatedTokenCount(): number {
    if (!existsSync(this.memoryPath)) return 0;
    return Math.ceil(readFileSync(this.memoryPath, "utf-8").length / 4);
  }
}
