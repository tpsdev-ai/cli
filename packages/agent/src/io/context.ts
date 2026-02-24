import type { MemoryStore, MemoryEvent } from "./memory.js";

/**
 * Sliding window context manager with compaction.
 *
 * When token usage approaches the configured window, the oldest 50%
 * of events are summarised into a dense state blob to preserve headroom
 * without losing history.
 */
export class ContextManager {
  constructor(
    private readonly memory: MemoryStore,
    private readonly windowTokens: number
  ) {}

  /** Return recent events that fit within the token window. */
  getWindow(): MemoryEvent[] {
    const all = this.memory.readAll();
    if (all.length === 0) return [];

    // Simple sliding-window: walk from newest, accumulate until budget
    const budget = this.windowTokens * 4; // chars ≈ tokens * 4
    let budget_remaining = budget;
    const window: MemoryEvent[] = [];

    for (let i = all.length - 1; i >= 0; i--) {
      const serialized = JSON.stringify(all[i]);
      if (serialized.length > budget_remaining) break;
      window.unshift(all[i]!);
      budget_remaining -= serialized.length;
    }

    return window;
  }

  /** Returns true if compaction is needed (>80% of window used). */
  needsCompaction(): boolean {
    return this.memory.estimatedTokenCount() > this.windowTokens * 0.8;
  }
}
