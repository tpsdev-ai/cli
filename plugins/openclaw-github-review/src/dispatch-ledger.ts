/**
 * dispatch-ledger.ts — AT MOST ONE VERDICT PER DISPATCH, for the processes
 * that share the latch store's lock.
 *
 * The guarantee rests on the durable latch store (audit.ts) and its exclusive
 * lock (store-lock.ts):
 *
 * - `reserve` is the CLAIM: under the lock it checks that the dispatch has no
 *   entry and durably writes `reserved` with the attempt's details and this
 *   call's claim — one atomic check-and-write, so of two processes (or calls)
 *   claiming one dispatch exactly one succeeds. It is a prerequisite to the
 *   POST: if it cannot be made durable, nothing is posted. The claim stays held
 *   across the POST, so the host's reconciliation refuses the dispatch while
 *   it is in flight;
 * - `settle` records the outcome (`posted`, or `reconcile_required` when it is
 *   uncertain) and drops the claim. If that write fails, the reservation and
 *   the claim stay: the failure only makes the dispatch more conservative;
 * - `unreserve` removes the reservation, ONLY after a response that proves no
 *   review was created. If that fails the reservation stays.
 *
 * In front of the store, an IN-FLIGHT set refuses a second call for the
 * dispatch in this process before any request (it is taken before the
 * handler's first await).
 *
 * The latch file is host-owned: a host that edits it by hand, or points two
 * hosts at one file, bypasses this guarantee.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { LatchDetails, LatchRecord, ReconcileStore } from "./types.js";

export class DispatchLedger {
  readonly #durable: ReconcileStore;
  readonly #inFlight = new Set<string>();
  /** The claim token this process holds for each dispatch it reserved. */
  readonly #claims = new Map<string, string>();

  constructor(durable: ReconcileStore) {
    this.#durable = durable;
  }

  /** The dispatch's latch entry, or null. THROWS when the store cannot be read. */
  latchOf(dispatchId: string): LatchRecord | null {
    return this.#durable.entry(dispatchId);
  }

  /** Enter a dispatch for one call in this process. False when another call holds it. */
  enter(dispatchId: string): boolean {
    if (this.#inFlight.has(dispatchId)) return false;
    this.#inFlight.add(dispatchId);
    return true;
  }

  leave(dispatchId: string): void {
    this.#inFlight.delete(dispatchId);
  }

  /** CLAIM the dispatch durably before posting. Returns the entry that already
   *  holds it (writing nothing), or null once `reserved` and this call's claim
   *  are durable. THROWS when the claim cannot be made (store unreadable,
   *  locked or unwritable): the caller must not post. */
  reserve(dispatchId: string, details: LatchDetails, now: string): LatchRecord | null {
    const token = randomBytes(16).toString("hex");
    const existing = this.#durable.reserve(dispatchId, details, { token, pid: process.pid, host: hostname(), at: now });
    if (!existing) this.#claims.set(dispatchId, token);
    return existing;
  }

  /** Record a post's outcome and drop the claim. Never throws: false when the
   *  write failed, in which case the reservation and the claim stay. */
  settle(dispatchId: string, latch: "posted" | "reconcile_required", details: Partial<LatchDetails> = {}): boolean {
    try {
      const token = this.#claims.get(dispatchId);
      if (token === undefined) return false;
      this.#durable.settle(dispatchId, token, latch, details);
      this.#claims.delete(dispatchId);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the reservation after a response that PROVES no review was
   *  created. Never throws: false when it could not be removed, in which case
   *  the reservation and the claim stay. */
  unreserve(dispatchId: string): boolean {
    try {
      const token = this.#claims.get(dispatchId);
      if (token === undefined) return false;
      this.#durable.release(dispatchId, token);
      this.#claims.delete(dispatchId);
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
