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
  | "assignment_ambiguous"
  | "assignment_mismatch"
  | "assignment_expired"
  | "unsupported_event"
  | "body_limit_unconfigured"
  | "body_too_large"
  | "credential_unavailable"
  | "signing_unavailable"
  | "scope_unverified"
  | "store_unconfigured"
  | "store_unavailable"
  | "reconcile_required"
  | "already_posted"
  | "dispatch_in_flight"
  | "pr_unavailable"
  | "pr_not_open"
  | "commit_mismatch"
  | "receipt_invalid"
  | "github_rejected"
  | "github_ambiguous";

/** A completed post. `posted` = receipt validated and audit acknowledged;
 *  `posted_audit_pending` = the audit write failed and the record is retained
 *  for host-side retry; `posted_audit_unretained` = the audit write failed AND
 *  its retention was not durably confirmed (a retention write may have become
 *  visible before failing); a host log line naming the event is attempted. */
export interface PostedOutcome {
  ok: true;
  status: "posted" | "posted_audit_pending" | "posted_audit_unretained";
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

/** The result of resolving a session's dispatch assignment. More than one
 *  entry for a session is AMBIGUOUS and is never resolved by position. */
export type AssignmentLookup =
  | { status: "found"; assignment: DispatchAssignment }
  | { status: "missing" }
  | { status: "ambiguous" };

export interface AssignmentResolver {
  resolve(sessionKey: string): AssignmentLookup;
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
    /** `rejected` ONLY when the response proves no review was created (see
     *  github.ts, NO_CREATE_STATUSES); anything else that is not a 2xx is
     *  `ambiguous`. */
    | { ok: false; kind: "rejected" | "ambiguous"; detail: string }
  >;
}

/** One review on a pull request, as the host's reconciliation reads it. */
export interface ExistingReview {
  id: number;
  login: string | null;
  commitId: string | null;
  state: string;
  url: string | null;
  /** ISO time the review was submitted; null for a pending review. */
  submittedAt: string | null;
}

/** The READ-ONLY review listing used by the host's reconciliation
 *  (latch-admin.ts). It is not part of the handler's GitHubApi surface. */
export interface GitHubReviewLister {
  listReviews(repo: string, pr: number): Promise<{ ok: true; reviews: ExistingReview[] } | { ok: false; detail: string }>;
}

/** The Flair OrgEvent draft, mapped per section D. `id` is host-generated and
 *  retained across audit retries. */
export interface OrgEventDraft {
  id: string;
  authorId: string;
  /** `pr_review_posted` for a review; `pr_review_reconciled` for the host's
   *  reconciliation of a dispatch latch. Values of the existing field. */
  kind: "pr_review_posted" | "pr_review_reconciled";
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
 *  restart can retry the audit WITHOUT reposting the review. Every method
 *  THROWS when the store cannot be read or written; none of them ever replaces
 *  a store it could not parse. */
export interface PendingAuditStore {
  list(): OrgEventDraft[];
  save(event: OrgEventDraft): void;
  remove(id: string): void;
  /** Prove the store is readable and writable now; throws otherwise. */
  probe(): void;
}

/** Why a dispatch is latched.
 *  - `reserved`: written durably, under the store lock, BEFORE the review is
 *    POSTed, together with the gateway's CLAIM on the dispatch. While the
 *    claim is held the attempt is in flight; a reservation still there when
 *    the claim is gone, or whose claim outlived its process, means the outcome
 *    was never recorded: the review may exist.
 *  - `reconcile_required`: the attempt's outcome is uncertain (an ambiguous
 *    GitHub response, or a 2xx whose receipt did not validate).
 *  - `posted`: the dispatch's verdict exists on GitHub. Final.
 *  `reserved` and `reconcile_required` refuse every call. Only ONE thing
 *  removes a latch: the handler, after a response that PROVES its own POST
 *  created no review (github.ts). The host's reconciliation (latch-admin.ts)
 *  never releases: it latches `posted` when the recorded receipt id is listed;
 *  otherwise the dispatch stays latched and a fresh dispatch reviews again. */
export type DispatchLatch = "reserved" | "reconcile_required" | "posted";

/** What the latch store records about a dispatch's attempt, so the host's
 *  reconciliation can look for the review on GitHub with the SAME credential. */
export interface LatchDetails {
  repo: string;
  pr: number;
  /** The commit the review was posted against. */
  commit: string;
  /** The verified GitHub login the review would be posted as. */
  login: string;
  /** sha256 of the credential that made the attempt (the binding the
   *  provisioning evidence records) — a fingerprint, never the token. */
  credentialSha256: string;
  /** When the attempt was reserved (ISO). */
  reservedAt: string;
  /** The review id from a 2xx receipt, when there was one: proof that a
   *  review was created. */
  reviewId?: number | null;
}

/** The gateway's claim on a dispatch, held across its POST. `token` is random
 *  and identifies the claiming call; pid and host say who holds it. */
export interface LatchClaim {
  token: string;
  pid: number;
  host: string;
  at: string;
}

/** One dispatch's entry in the latch store. */
export interface LatchRecord extends Partial<LatchDetails> {
  dispatchId: string;
  latch: DispatchLatch;
  claim?: LatchClaim;
}

/** The durable per-dispatch latch store. Every write runs under the store's
 *  exclusive lock (store-lock.ts) and is durable before it returns
 *  (durable-file.ts); every method THROWS when the store cannot be read,
 *  locked or written, and none replaces a store it could not parse. */
export interface ReconcileStore {
  /** The dispatch's entry, or null (a read; no lock needed). */
  entry(dispatchId: string): LatchRecord | null;
  /** CLAIM: under the lock, if the dispatch has any entry return it and write
   *  nothing; otherwise durably write `reserved` with the attempt details and
   *  this claim, and return null. */
  reserve(dispatchId: string, details: LatchDetails, claim: LatchClaim): LatchRecord | null;
  /** Under the lock: record the outcome of the attempt holding `claimToken`
   *  and drop its claim. Throws if the entry is not held by that claim. */
  settle(dispatchId: string, claimToken: string, latch: "posted" | "reconcile_required", details?: Partial<LatchDetails>): void;
  /** Under the lock: remove the reservation held by `claimToken` — only after
   *  a response that proves no review was created. Throws if not held by it. */
  release(dispatchId: string, claimToken: string): void;
  /** Prove the store is readable and writable now; throws otherwise. */
  probe(): void;
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
