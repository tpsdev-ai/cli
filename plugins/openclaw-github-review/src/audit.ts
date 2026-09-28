/**
 * audit.ts — the signed Flair OrgEvent and the pending-audit retry store.
 *
 * Section D: for every successfully created GitHub review, publish a Flair
 * OrgEvent through the host-side authenticated signing path, using the existing
 * schema (no added table fields). The `detail` carries host-verified metadata;
 * the digest commits to the exact body bytes sent.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AuditSink, OrgEventDraft, PendingAuditStore, ReviewEvent, ReviewReceipt, RuntimeEvidence } from "./types.js";

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

interface PendingFileShape {
  events?: unknown;
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
 *  reposting the review. */
export class FilePendingAuditStore implements PendingAuditStore {
  private events: OrgEventDraft[];

  constructor(private readonly file: string) {
    this.events = this.read();
  }

  private read(): OrgEventDraft[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PendingFileShape;
      return Array.isArray(parsed.events) ? parsed.events.filter(isDraft) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ events: this.events }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): OrgEventDraft[] {
    return [...this.events];
  }

  save(event: OrgEventDraft): void {
    if (this.events.some((e) => e.id === event.id)) return;
    this.events.push(event);
    this.write();
  }

  remove(id: string): void {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.id !== id);
    if (this.events.length !== before) this.write();
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
