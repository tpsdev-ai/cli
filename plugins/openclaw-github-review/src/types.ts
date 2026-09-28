/**
 * types.ts — the shared vocabulary of the github_review plugin.
 *
 * The plugin is deliberately small and independent: it holds ONE production
 * verb, and everything it needs to authorize and audit a post comes from
 * trusted host context, never from the caller.
 */

/** The three supported review events. Nothing else is accepted. */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** The exact caller-visible input. No `repo`/`pr` trust is taken from it: it is
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
  | "handler_sandboxed"
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
  | "pr_unavailable"
  | "pr_not_open"
  | "commit_mismatch"
  | "receipt_invalid"
  | "github_rejected"
  | "github_ambiguous";

/** The terminal outcome of one dispatch. `posted_audit_pending` is a partial:
 *  GitHub created the review but auditing has not been acknowledged. */
export type Outcome =
  | {
      ok: true;
      status: "posted";
      reviewId: number;
      reviewUrl: string;
      commitId: string;
      auditEventId: string;
      login: string;
    }
  | {
      ok: true;
      status: "posted_audit_pending";
      reviewId: number;
      reviewUrl: string;
      commitId: string;
      auditEventId: string;
      login: string;
    }
  | {
      ok: false;
      reason: RefusalReason;
      actor: string | null;
      state: string;
      remedy: string;
    };

/** Trusted, host-resolved session facts. The tool factory receives these from
 *  the gateway; nothing here is caller-controlled. */
export interface SessionContext {
  /** The gateway session key, the key the dispatch assignment is bound to. */
  sessionKey: string | null;
  /** Whether the run is executing inside the sandbox. The handler MUST run in
   *  the gateway process, so a sandboxed run is refused outright. */
  sandboxed: boolean;
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

/** Host-resolved runtime/attestation metadata recorded in the audit detail. */
export interface RuntimeEvidence {
  bunVersion: string | null;
  nodeVersion: string | null;
  sandboxImageDigest: string | null;
  pluginVersion: string;
}
