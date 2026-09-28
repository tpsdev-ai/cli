/**
 * audit.ts — the signed Flair OrgEvent and the pending-audit retry store.
 *
 * Section D: for every successfully created GitHub review, publish a Flair
 * OrgEvent through the host-side authenticated signing path, using the existing
 * schema (no added table fields). The `detail` carries host-verified metadata;
 * the digest commits to the exact body bytes sent.
 */

import { probeWritable, readJsonStore, writeJsonStore } from "./durable-file.js";
import type {
  AuditSink,
  DispatchLatch,
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
 *  empty, and anything else it cannot parse THROWS — it is never replaced. */
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
    const events = this.list();
    if (events.some((e) => e.id === event.id)) return;
    events.push(event);
    writeJsonStore(this.file, { events });
  }

  remove(id: string): void {
    const events = this.list();
    const kept = events.filter((e) => e.id !== id);
    if (kept.length !== events.length) writeJsonStore(this.file, { events: kept });
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

/** One entry of the durable dispatch latch store. */
export interface LatchEntry {
  dispatchId: string;
  latch: DispatchLatch;
}

const LATCHES: ReadonlySet<string> = new Set<DispatchLatch>(["reconcile_required", "posted"]);

/** The durable per-dispatch latch store: `{"latches":[{"dispatchId","latch"}]}`.
 *  Once a dispatch is latched it stays latched until the HOST clears it (see
 *  latch-admin.ts), so a retry cannot post a second review. The file is read
 *  on every operation; a missing file is empty, and anything else it cannot
 *  parse THROWS — `add` and `clear` never replace a file they could not parse. */
export class FileReconcileStore implements ReconcileStore {
  constructor(private readonly file: string) {}

  list(): LatchEntry[] {
    const parsed = readJsonStore(this.file);
    if (parsed === undefined) return [];
    const latches = typeof parsed === "object" && parsed !== null ? (parsed as { latches?: unknown }).latches : undefined;
    if (!Array.isArray(latches)) throw new Error("the dispatch latch store has an unrecognised shape");
    return latches.map((entry) => {
      const o = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
      if (!o || typeof o.dispatchId !== "string" || typeof o.latch !== "string" || !LATCHES.has(o.latch)) {
        throw new Error("the dispatch latch store has an unrecognised entry");
      }
      return { dispatchId: o.dispatchId, latch: o.latch as DispatchLatch };
    });
  }

  get(dispatchId: string): DispatchLatch | null {
    return this.list().find((e) => e.dispatchId === dispatchId)?.latch ?? null;
  }

  add(dispatchId: string, latch: DispatchLatch): void {
    const entries = this.list();
    const existing = entries.find((e) => e.dispatchId === dispatchId);
    if (existing?.latch === latch) return;
    if (existing) existing.latch = latch;
    else entries.push({ dispatchId, latch });
    writeJsonStore(this.file, { latches: entries });
  }

  /** Remove a dispatch's latch. Returns whether one was removed. */
  clear(dispatchId: string): boolean {
    const entries = this.list();
    const kept = entries.filter((e) => e.dispatchId !== dispatchId);
    if (kept.length === entries.length) return false;
    writeJsonStore(this.file, { latches: kept });
    return true;
  }

  probe(): void {
    this.list();
    probeWritable(this.file);
  }
}

/** An in-memory latch store for tests. */
export class MemoryReconcileStore implements ReconcileStore {
  private latches = new Map<string, DispatchLatch>();
  get(dispatchId: string): DispatchLatch | null {
    return this.latches.get(dispatchId) ?? null;
  }
  add(dispatchId: string, latch: DispatchLatch): void {
    this.latches.set(dispatchId, latch);
  }
  clear(dispatchId: string): void {
    this.latches.delete(dispatchId);
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
