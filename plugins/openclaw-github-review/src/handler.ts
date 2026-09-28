/**
 * handler.ts — the single production flow behind `github_review`.
 *
 * The order below is the authorization order in section B: local, cheap checks
 * and the credential/scope gate run BEFORE any outbound request; only then does
 * the host fetch the PR, and the post is constructed and its receipt validated
 * host-side. `repo`, `pr` and `commit_id` ARE caller input — they are accepted
 * only when they equal the trusted dispatch assignment and the host-fetched
 * head.
 */

import { createHash } from "node:crypto";
import { buildOrgEvent } from "./audit.js";
import type { CredentialCustody } from "./credential.js";
import {
  REVIEW_EVENTS,
  type AssignmentResolver,
  type AuditSink,
  type GitHubApi,
  type Outcome,
  type PendingAuditStore,
  type ReconcileStore,
  type RefusalReason,
  type ReviewEvent,
  type RuntimeEvidence,
  type SessionContext,
} from "./types.js";
import type { GithubReviewConfig } from "./config.js";

export interface HandlerDeps {
  config: GithubReviewConfig;
  custody: CredentialCustody;
  assignments: AssignmentResolver;
  github: GitHubApi;
  audit: AuditSink;
  pendingAudits: PendingAuditStore;
  reconcile: ReconcileStore;
  runtime: RuntimeEvidence;
  clock: () => Date;
  newId: () => string;
}

const ALLOWED_INPUT_KEYS = new Set(["repo", "pr", "commit_id", "event", "body"]);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/;

function refuse(reason: RefusalReason, actor: string | null, state: string, remedy: string): Outcome {
  return { ok: false, reason, actor, state, remedy };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The expected GitHub review state for a requested event. */
function expectedReceiptState(event: ReviewEvent): string {
  if (event === "APPROVE") return "APPROVED";
  if (event === "REQUEST_CHANGES") return "CHANGES_REQUESTED";
  return "COMMENTED";
}

export async function runGithubReview(
  rawInput: unknown,
  ctx: SessionContext,
  deps: HandlerDeps,
): Promise<Outcome> {
  const { config, custody, assignments, github, audit, pendingAudits, reconcile, runtime, clock, newId } = deps;

  // ── input shape and unsupported fields ──
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return refuse("invalid_input", null, "tool input is not an object", "pass the documented input object");
  }
  const input = rawInput as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      return refuse("unsupported_field", null, `unexpected input field "${key}"`, "remove the unsupported field");
    }
  }
  const repo = input.repo;
  const pr = input.pr;
  const commitIdRaw = input.commit_id;
  const event = input.event;
  const body = input.body;

  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    return refuse("invalid_input", null, "repo must be owner/name", "pass repo as owner/name");
  }
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
    return refuse("invalid_input", null, "pr must be a positive integer", "pass a valid pull-request number");
  }
  if (typeof commitIdRaw !== "string" || !COMMIT_RE.test(commitIdRaw)) {
    return refuse("invalid_input", null, "commit_id must be a commit SHA", "pass the reviewed commit SHA");
  }
  if (typeof body !== "string") {
    return refuse("invalid_input", null, "body must be a string", "pass the review body as a string");
  }
  if (/\p{Cs}/u.test(body)) {
    return refuse(
      "invalid_input",
      null,
      "body is not well-formed Unicode (lone surrogate)",
      "remove unpaired surrogate code units from the body",
    );
  }
  if (typeof event !== "string" || !(REVIEW_EVENTS as readonly string[]).includes(event)) {
    return refuse(
      "unsupported_event",
      null,
      `event "${String(event)}" is not supported`,
      `use one of ${REVIEW_EVENTS.join(", ")}`,
    );
  }
  const reviewEvent = event as ReviewEvent;

  // ── repo must belong to the host-configured set ──
  if (!config.allowedRepositories.includes(repo)) {
    return refuse(
      "repo_not_configured",
      null,
      `${repo} is outside the configured repository set`,
      "configure the repository on the host before reviewing it",
    );
  }

  // ── session → trusted dispatch assignment ──
  if (!ctx.sessionKey) {
    return refuse("assignment_missing", null, "the session has no dispatch assignment", "dispatch the review from a trusted host component");
  }
  const assignment = assignments.resolve(ctx.sessionKey);
  if (!assignment) {
    return refuse("assignment_missing", null, "no dispatch assignment for this session", "create a trusted dispatch assignment for the session");
  }
  const actor = assignment.reviewer;
  if (ctx.agentId !== assignment.reviewer) {
    return refuse(
      "assignment_mismatch",
      actor,
      "the session's agent does not match the assignment's reviewer",
      "dispatch the review to the assignment's reviewer",
    );
  }
  if (!assignment.active) {
    return refuse("assignment_expired", actor, "the dispatch assignment is no longer active", "dispatch the review again");
  }
  const expiresMs = Date.parse(assignment.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= clock().getTime()) {
    return refuse("assignment_expired", actor, "the dispatch assignment has expired", "dispatch the review again");
  }
  if (assignment.repo !== repo || assignment.pr !== pr) {
    return refuse(
      "assignment_mismatch",
      actor,
      `the assignment binds ${assignment.repo}#${assignment.pr}, not ${repo}#${pr}`,
      "review the assigned pull request, or obtain a fresh assignment",
    );
  }
  if (config.reviewerIdentity === null || assignment.reviewer !== config.reviewerIdentity) {
    return refuse(
      "assignment_mismatch",
      actor,
      "the assignment's reviewer does not match the host signing identity",
      "dispatch the review to the reviewer whose signing key the host holds",
    );
  }

  // ── a latched unknown outcome refuses until the host reconciles ──
  if (reconcile.has(assignment.dispatchId)) {
    return refuse(
      "reconcile_required",
      actor,
      "a previous post for this dispatch has an unknown external state",
      "reconcile the pull request's reviews, then have the host clear the dispatch latch",
    );
  }

  // ── body byte limit (must be configured) ──
  if (config.maxBodyBytes === null) {
    return refuse("body_limit_unconfigured", actor, "no finite body byte limit is configured", "set maxBodyBytes in the plugin configuration and restart");
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > config.maxBodyBytes) {
    return refuse(
      "body_too_large",
      actor,
      `body is ${bodyBytes} bytes, over the ${config.maxBodyBytes}-byte limit`,
      "shorten the review body",
    );
  }

  // ── durable stores must be configured BEFORE any request ──
  if (!config.pendingAuditFile || !config.reconcileFile) {
    return refuse(
      "pending_audit_unconfigured",
      actor,
      `${!config.pendingAuditFile ? "pendingAuditFile" : "reconcileFile"} is not configured`,
      "configure both durable stores on the host and restart",
    );
  }

  // ── credential and signing facilities (local readiness) ──
  if (!custody.isReady()) {
    return refuse("credential_unavailable", actor, "no usable GitHub credential is loaded", "install a fine-grained token + provisioning evidence and restart");
  }
  if (!config.signingKeyFile) {
    return refuse("signing_unavailable", actor, "no Flair signing key is configured", "configure signingKeyFile and restart");
  }

  // ── C4: literal pre-request gate on trusted provisioning evidence ──
  const scope = custody.verifyForRepo(repo);
  if (!scope.ok) {
    return refuse(scope.reason, actor, scope.state, scope.remedy);
  }

  // ── host-authoritative PR lookup: open + head equality ──
  const lookup = await github.fetchPull(repo, pr);
  if (!lookup.ok) {
    return refuse("pr_unavailable", actor, lookup.detail, "retry once the PR is reachable");
  }
  if (lookup.pull.state !== "open") {
    return refuse("pr_not_open", actor, `PR ${repo}#${pr} is ${lookup.pull.state}`, "review open pull requests only");
  }
  const head = lookup.pull.head;
  if (commitIdRaw !== head || assignment.reviewedCommit !== head) {
    return refuse(
      "commit_mismatch",
      actor,
      "the submitted commit, the reviewed commit and the current head do not agree",
      "re-review the current head",
    );
  }

  // ── host-computed digest over the UTF-8 body handed to the serializer ──
  const bodySha256 = sha256Hex(Buffer.from(body, "utf8"));

  // ── post and validate the receipt ──
  const posted = await github.createReview({ repo, pr, commitId: head, event: reviewEvent, body });
  if (!posted.ok) {
    if (posted.kind === "rejected") {
      return refuse("github_rejected", actor, posted.detail, "correct the review and retry");
    }
    // AMBIGUOUS: a review may exist. Report an UNKNOWN state, never a refusal,
    // and latch the dispatch so a retry cannot post a second review.
    reconcile.add(assignment.dispatchId);
    return {
      ok: true,
      status: "unknown",
      reason: "reconcile_required",
      reviewId: null,
      reviewUrl: null,
      commitId: head,
      auditEventId: null,
      login: scope.login,
    };
  }
  const receipt = posted.receipt;

  // ── audit record (built from the confirmed receipt) ──
  const auditEventId = newId();
  const draft = buildOrgEvent({
    id: auditEventId,
    reviewer: actor,
    repo,
    pr,
    commitId: head,
    event: reviewEvent,
    bodySha256,
    receipt,
    sessionCorrelationId: assignment.dispatchId,
    runtime,
    login: scope.login,
    createdAt: clock().toISOString(),
  });

  // Receipt validation happens AFTER the audit record is built, because a 2xx
  // means the review exists and must be retained for the audit even when the
  // receipt does not match.
  if (receipt.commitId !== head || receipt.state !== expectedReceiptState(reviewEvent)) {
    reconcile.add(assignment.dispatchId);
    let retainedId: string | null = null;
    try {
      await audit.record(draft);
      retainedId = auditEventId;
    } catch {
      retainPendingAudit(pendingAudits, draft);
    }
    return {
      ok: true,
      status: "unknown",
      reason: "receipt_invalid",
      reviewId: receipt.id,
      reviewUrl: receipt.url,
      commitId: head,
      auditEventId: retainedId,
      login: scope.login,
    };
  }

  try {
    await audit.record(draft);
  } catch {
    // GitHub created the review but auditing failed: explicit partial outcome,
    // with the audit work retained host-side for retry. Never reported as a
    // complete success, and a retention failure is never allowed to throw.
    retainPendingAudit(pendingAudits, draft);
    return {
      ok: true,
      status: "posted_audit_pending",
      reviewId: receipt.id,
      reviewUrl: receipt.url,
      commitId: head,
      auditEventId,
      login: scope.login,
    };
  }

  return {
    ok: true,
    status: "posted",
    reviewId: receipt.id,
    reviewUrl: receipt.url,
    commitId: head,
    auditEventId,
    login: scope.login,
  };
}

/** Retain an audit record for host-side retry. A retention failure is caught
 *  and never thrown after a post; the failure text is not surfaced. */
function retainPendingAudit(pendingAudits: PendingAuditStore, draft: ReturnType<typeof buildOrgEvent>): void {
  try {
    pendingAudits.save(draft);
  } catch {
    // Best effort: the audit record is not retained, and nothing about the
    // host filesystem is disclosed. The result stays a partial outcome.
  }
}

/** A stable, safe JSON view of an outcome for the tool result. It contains no
 *  credential, no host path and no raw upstream error text. */
export function outcomeToJson(outcome: Outcome): string {
  if (outcome.ok) {
    if (outcome.status === "unknown") {
      return JSON.stringify({
        status: "unknown",
        reason: outcome.reason,
        review_id: outcome.reviewId,
        review_url: outcome.reviewUrl,
        commit_id: outcome.commitId,
        audit_event_id: outcome.auditEventId,
        github_login: outcome.login,
      });
    }
    return JSON.stringify({
      status: outcome.status,
      review_id: outcome.reviewId,
      review_url: outcome.reviewUrl,
      commit_id: outcome.commitId,
      audit_event_id: outcome.auditEventId,
      github_login: outcome.login,
    });
  }
  return JSON.stringify({
    status: "refused",
    reason: outcome.reason,
    actor: outcome.actor,
    state: outcome.state,
    remedy: outcome.remedy,
  });
}
