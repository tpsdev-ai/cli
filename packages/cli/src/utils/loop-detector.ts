import { createHash } from "node:crypto";

export interface LoopDetectorOptions {
  /** Max duplicate messages before triggering. Default: 3 */
  threshold?: number;
  /** Time window in ms. Default: 300_000 (5 min) */
  windowMs?: number;
}

interface HashEntry {
  hash: string;
  timestamp: number;
}

export class LoopDetector {
  private history: HashEntry[] = [];
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor(opts: LoopDetectorOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.windowMs = opts.windowMs ?? 300_000;
  }

  /** Hash a message body (SHA-256, first 16 hex chars) */
  private hash(body: string): string {
    return createHash("sha256").update(body).digest("hex").slice(0, 16);
  }

  /** Prune entries outside the time window */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.history = this.history.filter((e) => e.timestamp > cutoff);
  }

  /**
   * Check if a message body is a duplicate.
   * Returns true if this message should be PAUSED (loop detected).
   * Always records the hash regardless of result.
   */
  check(body: string): boolean {
    this.prune();
    const h = this.hash(body);
    this.history.push({ hash: h, timestamp: Date.now() });
    const count = this.history.filter((e) => e.hash === h).length;
    return count >= this.threshold;
  }

  /** Reset all history (e.g., after manual intervention) */
  reset(): void {
    this.history = [];
  }

  /** Get current duplicate count for a body */
  duplicateCount(body: string): number {
    this.prune();
    const h = this.hash(body);
    return this.history.filter((e) => e.hash === h).length;
  }
}
