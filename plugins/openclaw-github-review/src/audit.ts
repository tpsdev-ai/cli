/**
 * audit.ts — the signed Flair OrgEvent and the pending-audit retry store.
 *
 * Section D: for every successfully created GitHub review, publish a Flair
 * OrgEvent through the host-side authenticated signing path, using the existing
 * schema (no added table fields). The `detail` carries host-verified metadata;
 * the digest commits to the exact body bytes sent.
 */

import { probeWritable, readJsonStore, writeJsonStore } from "./durable-file.js";
import { withStoreLock } from "./store-lock.js";
import type {
  AuditSink,
  DispatchLatch,
  LatchClaim,
  LatchDetails,
  LatchRecord,
  OrgEventDraft,
  PendingAuditStore,
  ReconcileStore,
  ReviewEvent,
  ReviewReceipt,
  RuntimeEvidence,
} from "./types.js";

/** The minimal Flair request surface the audit sink uses. A real FlairClient
 *  satisfies it; tests inject a fake. */
export interface FlairLikeClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export class FlairAuditSink implements AuditSink {
  constructor(
    private readonly client: FlairLikeClient,
    private readonly reviewer: string,
  ) {}

  async record(event: OrgEventDraft): Promise<void> {
    // The authenticated identity is the reviewer's; authorId matches the signer.
    await this.client.request("POST", "/OrgEvent/", {
      id: event.id,
      authorId: this.reviewer,
      kind: event.kind,
      scope: event.scope,
      refId: event.refId,
      targetIds: event.targetIds,
      summary: event.summary,
      detail: event.detail,
      createdAt: event.createdAt,
    });
  }
}

export interface BuildOrgEventParams {
  id: string;
  reviewer: string;
  repo: string;
  pr: number;
  commitId: string;
  event: ReviewEvent;
  bodySha256: string;
  receipt: ReviewReceipt;
  /** Opaque session/dispatch correlation id. */
  sessionCorrelationId: string;
  runtime: RuntimeEvidence;
  /** The verified login from the credential's provisioning record. */
  login: string;
  createdAt: string;
}

/** Map the review to an OrgEvent exactly as section D prescribes. Every field
 *  except the submitted body and the requested event is resolved host-side. */
export function buildOrgEvent(p: BuildOrgEventParams): OrgEventDraft {
  const detail = JSON.stringify({
    repo: p.repo,
    pr: p.pr,
    commit_id: p.commitId,
    event: p.event,
    body_sha256: p.bodySha256,
    review_id: p.receipt.id,
    review_url: p.receipt.url,
    commit_sha: p.receipt.commitId,
    reviewer: p.reviewer,
    session_correlation_id: p.sessionCorrelationId,
    bun_version: p.runtime.bunVersion,
    node_version: p.runtime.nodeVersion,
    sandbox_image_digest: p.runtime.sandboxImageDigest,
    plugin_version: p.runtime.pluginVersion,
    github_login: p.login,
  });
  const shortCommit = p.commitId.slice(0, 12);
  return {
    id: p.id,
    authorId: p.reviewer,
    kind: "pr_review_posted",
    scope: p.repo,
    refId: String(p.pr),
    targetIds: [String(p.pr), p.commitId],
    summary: `${p.event} review posted on ${p.repo}#${p.pr} @ ${shortCommit}`,
    detail,
    createdAt: p.createdAt,
  };
}

function isDraft(v: unknown): v is OrgEventDraft {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.authorId === "string" &&
    typeof o.kind === "string" &&
    typeof o.summary === "string" &&
    typeof o.detail === "string" &&
    typeof o.createdAt === "string"
  );
}

/** A durable pending-audit store: an OrgEvent whose write failed after a
 *  confirmed GitHub post is retained here and retried on the next start WITHOUT
 *  reposting the review. The file is read on every operation; a missing file is
 *  empty, and anything else it cannot parse THROWS — it is never replaced.
 *  Every read-modify-write runs under the store's lock (store-lock.ts). */
export class FilePendingAuditStore implements PendingAuditStore {
  constructor(private readonly file: string) {}

  list(): OrgEventDraft[] {
    const parsed = readJsonStore(this.file);
    if (parsed === undefined) return [];
    const events = typeof parsed === "object" && parsed !== null ? (parsed as { events?: unknown }).events : undefined;
    if (!Array.isArray(events) || !events.every(isDraft)) {
      throw new Error("the pending-audit store has an unrecognised shape");
    }
    return events;
  }

  save(event: OrgEventDraft): void {
    withStoreLock(this.file, "pending-audit save", () => {
      const events = this.list();
      if (events.some((e) => e.id === event.id)) return;
      events.push(event);
      writeJsonStore(this.file, { events });
    });
  }

  remove(id: string): void {
    withStoreLock(this.file, "pending-audit remove", () => {
      const events = this.list();
      const kept = events.filter((e) => e.id !== id);
      if (kept.length !== events.length) writeJsonStore(this.file, { events: kept });
    });
  }

  probe(): void {
    this.list();
    probeWritable(this.file);
  }
}

/** An in-memory pending-audit store for tests. */
export class MemoryPendingAuditStore implements PendingAuditStore {
  private events: OrgEventDraft[] = [];
  list(): OrgEventDraft[] {
    return [...this.events];
  }
  save(event: OrgEventDraft): void {
    if (!this.events.some((e) => e.id === event.id)) this.events.push(event);
  }
  remove(id: string): void {
    this.events = this.events.filter((e) => e.id !== id);
  }
  probe(): void {}
}

const LATCHES: ReadonlySet<string> = new Set<DispatchLatch>(["reserved", "reconcile_required", "posted"]);

/** Validate one stored entry; anything unrecognised throws. */
function parseLatchEntry(entry: unknown): LatchRecord {
  const o = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
  const optional = (key: string, type: "string" | "number") => o![key] === undefined || typeof o![key] === type;
  const claim = o?.claim as Record<string, unknown> | undefined;
  const claimOk =
    claim === undefined ||
    (typeof claim === "object" &&
      claim !== null &&
      typeof claim.token === "string" &&
      typeof claim.pid === "number" &&
      typeof claim.host === "string" &&
      typeof claim.at === "string");
  if (
    !o ||
    typeof o.dispatchId !== "string" ||
    typeof o.latch !== "string" ||
    !LATCHES.has(o.latch) ||
    !optional("repo", "string") ||
    !optional("pr", "number") ||
    !optional("commit", "string") ||
    !optional("login", "string") ||
    !optional("credentialSha256", "string") ||
    !optional("reservedAt", "string") ||
    !(o.reviewId === undefined || o.reviewId === null || typeof o.reviewId === "number") ||
    !claimOk
  ) {
    throw new Error("the dispatch latch store has an unrecognised entry");
  }
  return o as unknown as LatchRecord;
}

/** The durable per-dispatch latch store: `{"latches":[LatchRecord…]}`.
 *  Reads need no lock (a replacement is atomic, so a reader sees the old file
 *  or the new one); every read-modify-write runs under the store's exclusive
 *  lock (store-lock.ts), which makes the gateway's claim a check-and-write
 *  that no other process sharing the lock can interleave. A missing file is
 *  empty; anything else it cannot parse THROWS, and no write replaces a file
 *  it could not parse. Every write is durable before it returns. */
export class FileReconcileStore implements ReconcileStore {
  constructor(private readonly file: string) {}

  list(): LatchRecord[] {
    const parsed = readJsonStore(this.file);
    if (parsed === undefined) return [];
    const latches = typeof parsed === "object" && parsed !== null ? (parsed as { latches?: unknown }).latches : undefined;
    if (!Array.isArray(latches)) throw new Error("the dispatch latch store has an unrecognised shape");
    return latches.map(parseLatchEntry);
  }

  entry(dispatchId: string): LatchRecord | null {
    return this.list().find((e) => e.dispatchId === dispatchId) ?? null;
  }

  get(dispatchId: string): DispatchLatch | null {
    return this.entry(dispatchId)?.latch ?? null;
  }

  /** Run a read-modify-write of the entries under the store lock. `fn`
   *  returns the new entry list, or null to write nothing. */
  private update<T>(op: string, fn: (entries: LatchRecord[]) => { entries: LatchRecord[] | null; result: T }): T {
    return withStoreLock(this.file, op, () => {
      const { entries, result } = fn(this.list());
      if (entries) writeJsonStore(this.file, { latches: entries });
      return result;
    });
  }

  reserve(dispatchId: string, details: LatchDetails, claim: LatchClaim): LatchRecord | null {
    return this.update("reserve", (entries) => {
      const existing = entries.find((e) => e.dispatchId === dispatchId);
      if (existing) return { entries: null, result: existing };
      return { entries: [...entries, { ...details, dispatchId, latch: "reserved", claim }], result: null };
    });
  }

  settle(dispatchId: string, claimToken: string, latch: "posted" | "reconcile_required", details: Partial<LatchDetails> = {}): void {
    this.update(`settle ${latch}`, (entries) => {
      const index = entries.findIndex((e) => e.dispatchId === dispatchId && e.claim?.token === claimToken);
      if (index < 0) throw new Error("the dispatch's latch is not held by this claim");
      const { claim: _dropped, ...rest } = entries[index]!;
      const next = [...entries];
      next[index] = { ...rest, ...details, dispatchId, latch };
      return { entries: next, result: undefined };
    });
  }

  release(dispatchId: string, claimToken: string): void {
    this.update("release", (entries) => {
      const held = entries.find((e) => e.dispatchId === dispatchId && e.latch === "reserved" && e.claim?.token === claimToken);
      if (!held) throw new Error("the dispatch's reservation is not held by this claim");
      return { entries: entries.filter((e) => e !== held), result: undefined };
    });
  }

  /** HOST: replace a dispatch's entry (or remove it with `next === null)` only
   *  if it is still exactly `expected` (compare-and-swap under the lock).
   *  Returns false, writing nothing, when it changed. */
  replaceIf(dispatchId: string, expected: LatchRecord, next: LatchRecord | null): boolean {
    return this.update("host reconcile", (entries) => {
      const index = entries.findIndex((e) => e.dispatchId === dispatchId);
      if (index < 0 || JSON.stringify(entries[index]) !== JSON.stringify(expected)) return { entries: null, result: false };
      const out = [...entries];
      if (next) out[index] = next;
      else out.splice(index, 1);
      return { entries: out, result: true };
    });
  }

  /** Write an entry as given, under the lock (tests and host repair). */
  put(record: LatchRecord): void {
    this.update("put", (entries) => ({
      entries: [...entries.filter((e) => e.dispatchId !== record.dispatchId), record],
      result: undefined,
    }));
  }

  probe(): void {
    this.list();
    probeWritable(this.file);
  }
}

/** An in-memory latch store for tests, with the same claim semantics. */
export class MemoryReconcileStore implements ReconcileStore {
  readonly entries = new Map<string, LatchRecord>();
  entry(dispatchId: string): LatchRecord | null {
    return this.entries.get(dispatchId) ?? null;
  }
  reserve(dispatchId: string, details: LatchDetails, claim: LatchClaim): LatchRecord | null {
    const existing = this.entries.get(dispatchId);
    if (existing) return existing;
    this.entries.set(dispatchId, { ...details, dispatchId, latch: "reserved", claim });
    return null;
  }
  settle(dispatchId: string, claimToken: string, latch: "posted" | "reconcile_required", details: Partial<LatchDetails> = {}): void {
    const e = this.entries.get(dispatchId);
    if (!e || e.claim?.token !== claimToken) throw new Error("the dispatch's latch is not held by this claim");
    const { claim: _dropped, ...rest } = e;
    this.entries.set(dispatchId, { ...rest, ...details, dispatchId, latch });
  }
  release(dispatchId: string, claimToken: string): void {
    const e = this.entries.get(dispatchId);
    if (!e || e.latch !== "reserved" || e.claim?.token !== claimToken) throw new Error("the dispatch's reservation is not held by this claim");
    this.entries.delete(dispatchId);
  }
  probe(): void {}
}

/** Retry every retained audit record once. Returns the ids that were
 *  acknowledged and were therefore removed. Never posts a GitHub review. */
export async function retryPendingAudits(
  store: PendingAuditStore,
  audit: AuditSink,
): Promise<{ acknowledged: string[]; stillPending: string[] }> {
  const acknowledged: string[] = [];
  const stillPending: string[] = [];
  for (const event of store.list()) {
    try {
      await audit.record(event);
      store.remove(event.id);
      acknowledged.push(event.id);
    } catch {
      stillPending.push(event.id);
    }
  }
  return { acknowledged, stillPending };
}
