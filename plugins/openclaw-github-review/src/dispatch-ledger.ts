/**
 * dispatch-ledger.ts — EXACTLY ONE VERDICT PER DISPATCH.
 *
 * The ledger sits in front of the durable latch store and adds two in-process
 * guards:
 *
 * - an IN-FLIGHT set: while one `github_review` call for a dispatch is between
 *   its pre-request checks and its outcome, a second call for the same
 *   dispatch is refused. The check and the claim run synchronously, before the
 *   handler's first await, so two calls cannot both claim a dispatch;
 * - a MEMORY latch: when a latch cannot be written to the durable store after a
 *   post, it is held here instead, so the latch still holds until the gateway
 *   restarts. A memory latch is recorded ONLY when the durable write failed, so
 *   a latch the host clears from the durable store stops refusing at once.
 */

import type { DispatchLatch, ReconcileStore } from "./types.js";

export class DispatchLedger {
  readonly #durable: ReconcileStore;
  readonly #memory = new Map<string, DispatchLatch>();
  readonly #inFlight = new Set<string>();

  constructor(durable: ReconcileStore) {
    this.#durable = durable;
  }

  /** The latch holding a dispatch, or null. THROWS when the durable store
   *  cannot be read. */
  latchOf(dispatchId: string): DispatchLatch | null {
    const held = this.#memory.get(dispatchId);
    if (held) return held;
    return this.#durable.get(dispatchId);
  }

  /** Latch a dispatch. Never throws: returns true when the latch is durable and
   *  false when it could only be held in memory (until the gateway restarts). */
  latch(dispatchId: string, latch: DispatchLatch): boolean {
    try {
      this.#durable.add(dispatchId, latch);
      return true;
    } catch {
      this.#memory.set(dispatchId, latch);
      return false;
    }
  }

  /** Claim a dispatch for one in-flight call. False when another call holds it. */
  claim(dispatchId: string): boolean {
    if (this.#inFlight.has(dispatchId)) return false;
    this.#inFlight.add(dispatchId);
    return true;
  }

  release(dispatchId: string): void {
    this.#inFlight.delete(dispatchId);
  }

  /** Prove the durable latch store is readable and writable now; throws otherwise. */
  probe(): void {
    this.#durable.probe();
  }
}
