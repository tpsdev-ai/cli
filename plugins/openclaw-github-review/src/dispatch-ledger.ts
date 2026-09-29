/**
 * dispatch-ledger.ts — ONE VERDICT PER DISPATCH.
 *
 * The guarantee rests on the durable latch store, written BEFORE the post:
 *
 * - `reserve` durably records `reserved` for the dispatch before the review is
 *   POSTed. It is a prerequisite: if it cannot be made durable, nothing is
 *   posted. From that moment until the outcome is recorded the dispatch is
 *   latched, so a crash anywhere between the reservation and the outcome write
 *   leaves `reserved` behind, and every later call refuses until the host's
 *   audited reconciliation (latch-admin.ts) has checked GitHub;
 * - `settle` records the outcome (`posted`, or `reconcile_required` when it is
 *   uncertain). If that write fails the reservation stays, which refuses the
 *   same way: the failure can only make the dispatch more conservative;
 * - `unreserve` removes the reservation after a DEFINITIVE rejection, which
 *   proves no review was created. If that fails the reservation stays.
 *
 * In front of the store, an IN-FLIGHT set refuses a second call for a dispatch
 * while one is running in this process. `claim` is taken before the handler's
 * first await, so two calls cannot both hold it.
 *
 * The latch file is host-owned: a host that edits it by hand bypasses this
 * guarantee.
 */

import type { DispatchLatch, LatchDetails, ReconcileStore } from "./types.js";

export class DispatchLedger {
  readonly #durable: ReconcileStore;
  readonly #inFlight = new Set<string>();

  constructor(durable: ReconcileStore) {
    this.#durable = durable;
  }

  /** The latch holding a dispatch, or null. THROWS when the store cannot be read. */
  latchOf(dispatchId: string): DispatchLatch | null {
    return this.#durable.get(dispatchId);
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

  /** Durably reserve the dispatch before posting. Returns the latch that
   *  already holds it (and writes nothing), or null once `reserved` is durable.
   *  THROWS when the reservation cannot be read or made durable: the caller
   *  must not post. */
  reserve(dispatchId: string, details: LatchDetails): DispatchLatch | null {
    const existing = this.#durable.get(dispatchId);
    if (existing) return existing;
    this.#durable.add(dispatchId, "reserved", details);
    return null;
  }

  /** Record a post's outcome. Never throws: false when the write failed, in
   *  which case the durable `reserved` latch still holds the dispatch. */
  settle(dispatchId: string, latch: "posted" | "reconcile_required", details: Partial<LatchDetails> = {}): boolean {
    try {
      this.#durable.add(dispatchId, latch, details);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the reservation after a definitive rejection. Never throws: false
   *  when it could not be removed, in which case the dispatch stays reserved. */
  unreserve(dispatchId: string): boolean {
    try {
      this.#durable.clear(dispatchId);
      return true;
    } catch {
      return false;
    }
  }

  /** Prove the durable latch store is readable and writable now; throws otherwise. */
  probe(): void {
    this.#durable.probe();
  }
}
