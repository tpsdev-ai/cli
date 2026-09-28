/**
 * types.ts — the shared vocabulary of the github_review plugin.
 *
 * The plugin is deliberately small and independent: it holds ONE production
 * verb. The caller supplies `repo`, `pr` and `commit_id`, which MUST equal the
 * trusted host dispatch assignment and the host-fetched head; they are never
 * trusted on their own. Everything else (identity, session, credentials, audit
 * metadata) comes from trusted host context.
 */

/** The three supported review events. Nothing else is accepted. */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** The exact caller-visible input. `repo` and `pr` are caller-supplied and are
 *  validated against the trusted dispatch assignment before use. */
export interface ReviewRequestInput {
  repo: string;
  pr: number;
  commit_id: string;
  event: ReviewEvent;
  body: string;
}

/** Stable refusal reasons. A refusal always carries one of these, the safely
 *  resolved actor (when known), the relevant state and a remedy. */
export type RefusalReason =
  | "invalid_input"
  | "unsupported_field"
  | "repo_not_configured"
  | "assignment_missing"
  | "assignment_mismatch"
  | "assignment_expired"
  | "unsupported_event"
  | "body_limit_unconfigured"
  | "body_too_large"
  | "credential_unavailable"
  | "signing_unavailable"
  | "scope_unverified"
  | "pending_audit_unconfigured"
  | "reconcile_required"
  | "pr_unavailable"
  | "pr_not_open"
  | "commit_mismatch"
  | "receipt_invalid"
  | "github_rejected"
  | "github_ambiguous";

/** A completed post. */
export interface PostedOutcome {
  ok: true;
  status: "posted" | "posted_audit_pending";
  reviewId: number;
  reviewUrl: string;
  commitId: string;
  auditEventId: string;
  login: string;
}

/** An outcome whose external state is not known to be clean: an ambiguous
 *  GitHub response, or a 2xx whose receipt did not validate. NEVER reported as
 *  a refusal, because a review may exist. */
export interface UnknownOutcome {
  ok: true;
  status: "unknown";
  reason: "reconcile_required" | "receipt_invalid";
  reviewId: number | null;
  reviewUrl: string | null;
  commitId: string;
  auditEventId: string | null;
  login: string;
}

export interface RefusedOutcome {
  ok: false;
  reason: RefusalReason;
  actor: string | null;
  state: string;
  remedy: string;
}

export type Outcome = PostedOutcome | UnknownOutcome | RefusedOutcome;

/** Trusted, host-resolved session facts. The tool factory receives these from
 *  the gateway. `agentId` is the gateway's agent for the run, bound to the
 *  assignment's reviewer; `sessionKey` keys the dispatch assignment. */
export interface SessionContext {
  sessionKey: string | null;
  agentId: string | null;
}

/** A trusted dispatch assignment: an immutable {repo, pr} bound to a reviewer
 *  session by a trusted host component at dispatch time. */
export interface DispatchAssignment {
  sessionKey: string;
  reviewer: string;
  repo: string;
  pr: number;
  /** The commit the host recorded when the review worktree was opened. */
  reviewedCommit: string;
  /** Opaque session/dispatch correlation id. */
  dispatchId: string;
  /** ISO timestamp after which the assignment is invalid. */
  expiresAt: string;
  /** Session completion invalidates the assignment. */
  active: boolean;
}

export interface AssignmentResolver {
  resolve(sessionKey: string): DispatchAssignment | null;
}

/** The public shape of a pull request fetched from GitHub by the host. */
export interface PullSnapshot {
  state: "open" | "closed";
  head: string;
}

export interface ReviewReceipt {
  id: number;
  url: string;
  commitId: string;
  state: string;
}

/** The narrow GitHub surface the handler is allowed to touch. It exposes no
 *  endpoint, header or method passthrough. */
export interface GitHubApi {
  fetchPull(
    repo: string,
    pr: number,
  ): Promise<{ ok: true; pull: PullSnapshot } | { ok: false; detail: string }>;
  createReview(input: {
    repo: string;
    pr: number;
    commitId: string;
    event: ReviewEvent;
    body: string;
  }): Promise<
    | { ok: true; receipt: ReviewReceipt }
    | { ok: false; kind: "rejected" | "ambiguous"; detail: string }
  >;
}

/** The Flair OrgEvent draft, mapped per section D. `id` is host-generated and
 *  retained across audit retries. */
export interface OrgEventDraft {
  id: string;
  authorId: string;
  kind: "pr_review_posted";
  scope: string;
  refId: string;
  targetIds: string[];
  summary: string;
  detail: string;
  createdAt: string;
}

export interface AuditSink {
  record(event: OrgEventDraft): Promise<void>;
}

/** Retains an OrgEvent whose write failed after a confirmed GitHub post, so a
 *  restart can retry the audit WITHOUT reposting the review. */
export interface PendingAuditStore {
  list(): OrgEventDraft[];
  save(event: OrgEventDraft): void;
  remove(id: string): void;
}

/** A durable per-dispatch latch that records an outcome whose external state is
 *  not known to be clean, so a retry does not post a second review. */
export interface ReconcileStore {
  has(dispatchId: string): boolean;
  add(dispatchId: string): void;
  clear(dispatchId: string): void;
}

/** Host-resolved runtime/attestation metadata recorded in the audit detail.
 *  The review environment's versions and image digest are supplied by the
 *  reviewer image (section A); until then they are recorded as null rather than
 *  presenting the gateway's own versions as the review's. */
export interface RuntimeEvidence {
  bunVersion: string | null;
  nodeVersion: string | null;
  sandboxImageDigest: string | null;
  pluginVersion: string;
}
