import type { MemoryStore, MemoryEvent } from "./memory.js";

/**
 * Sliding window context manager with token-based compaction.
 */
export class ContextManager {
  private encoder?: (text: string) => Promise<number[]> | number[];

  constructor(
    private readonly memory: MemoryStore,
    private readonly windowTokens: number
  ) {
    this.encoder = undefined;
  }

  private async getEncoder(): Promise<(text: string) => Promise<number[]> | number[]> {
    if (this.encoder) return this.encoder;

    try {
      const mod = await import("js-tiktoken");
      const fn =
        (mod as any).encodingForModel?.("gpt-4o") ||
        (mod as any).encoding_for_model?.("gpt-4o") ||
        (mod as any).getEncoding?.("cl100k_base");

      if (fn) {
        this.encoder = (text: string) => {
          const tokens = fn.encode(text);
          if (Array.isArray(tokens)) return tokens;
          return [];
        };
        return this.encoder;
      }
    } catch {}

    // Fallback: approximate tokenization (4 chars ~= 1 token)
    this.encoder = (text: string) => {
      const count = Math.max(1, Math.ceil(text.length / 4));
      return new Array(count);
    };
    return this.encoder;
  }

  private async countTokens(text: string): Promise<number> {
    const encode = await this.getEncoder();
    const tokens = await encode(text);
    return Array.isArray(tokens) ? tokens.length : 0;
  }

  /** Return recent events that fit within token window. */
  async getWindow(): Promise<MemoryEvent[]> {
    const all = this.memory.readAll();
    if (all.length === 0) return [];

    const budget = this.windowTokens;
    let budgetRemaining = budget;
    const window: MemoryEvent[] = [];

    for (let i = all.length - 1; i >= 0; i--) {
      const serialized = JSON.stringify(all[i]);
      const tokenCount = await this.countTokens(serialized);
      if (tokenCount > budgetRemaining) break;
      window.unshift(all[i]!);
      budgetRemaining -= tokenCount;
    }

    return window;
  }

  /** Returns true if compaction is needed (>80% of window used). */
  async needsCompaction(): Promise<boolean> {
    const total = await this.estimateTokenCount();
    return total > this.windowTokens * 0.8;
  }

  async estimateTokenCount(): Promise<number> {
    const events = this.memory.readAll();
    let total = 0;
    for (const event of events) {
      total += await this.countTokens(JSON.stringify(event));
    }
    return total;
  }
}
