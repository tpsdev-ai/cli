/**
 * handler.ts — the single production flow behind `github_review`.
 *
 * The order below is the authorization order in section B: local, cheap checks
 * and the credential/scope gate run BEFORE any outbound request; only then does
 * the host fetch the PR, and the post is constructed and its receipt validated
 * host-side. `repo`, `pr` and `commit_id` ARE caller input — they are accepted
 * only when they equal the trusted dispatch assignment and the host-fetched
 * head.
 *
 * ONE VERDICT PER DISPATCH (dispatch-ledger.ts): before the review is POSTed
 * the dispatch is durably RESERVED — if that write fails nothing is posted.
 * A validated receipt turns the reservation into `posted` (every later call:
 * `already_posted`); an uncertain outcome into `reconcile_required`; a
 * definitive rejection removes it. A reservation or `reconcile_required` latch
 * refuses every call (`reconcile_required`) until the host's audited
 * reconciliation checks GitHub and releases the dispatch only if no review
 * exists. While one call for a dispatch is in flight a second is refused
 * (`dispatch_in_flight`). The tool also declares `executionMode:
 * "sequential"`; the guards do not depend on it.
 *
 * NOTHING AFTER THE POST THROWS: the fallible metadata (event id, timestamp,
 * digest) is prepared before the reservation, and every step after the POST —
 * latch writes, the audit write, retention, host logging — is contained.
 */

import { createHash } from "node:crypto";
import { buildOrgEvent } from "./audit.js";
import type { CredentialCustody } from "./credential.js";
import type { DispatchLedger } from "./dispatch-ledger.js";
import {
  REVIEW_EVENTS,
  type AssignmentResolver,
  type AuditSink,
  type DispatchAssignment,
  type DispatchLatch,
  type GitHubApi,
  type OrgEventDraft,
  type Outcome,
  type PendingAuditStore,
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
  /** The per-dispatch latch and in-flight guard over the durable latch store. */
  ledger: DispatchLedger;
  runtime: RuntimeEvidence;
  clock: () => Date;
  newId: () => string;
  /** Writes ONE host log line. Callers never pass a path or a secret. */
  log: (line: string) => void;
}

const ALLOWED_INPUT_KEYS = new Set(["repo", "pr", "commit_id", "event", "body"]);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/;

function refuse(reason: RefusalReason, actor: string | null, state: string, remedy: string): Outcome {
  return { ok: false, reason, actor, state, remedy };
}

/** The refusal for a durable store that cannot be read or written. Its text
 *  names no path: the host log and the store's own location are the host's. */
function storeUnavailable(actor: string | null): Outcome {
  return refuse(
    "store_unavailable",
    actor,
    "a durable store (dispatch latches or pending audits) cannot be read or written",
    "the host must repair the store file or its directory; nothing was posted",
  );
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
  const { config, assignments, ledger, clock } = deps;

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
  const lookup = assignments.resolve(ctx.sessionKey);
  if (lookup.status === "ambiguous") {
    return refuse(
      "assignment_ambiguous",
      null,
      "more than one dispatch assignment binds this session",
      "the host must leave exactly one assignment for the session, then dispatch the review again",
    );
  }
  if (lookup.status !== "found") {
    return refuse("assignment_missing", null, "no dispatch assignment for this session", "create a trusted dispatch assignment for the session");
  }
  const assignment = lookup.assignment;
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

  // ── one call per dispatch at a time. The claim is taken synchronously,
  //    before the first await, so two calls cannot both hold it. ──
  if (!ledger.claim(assignment.dispatchId)) {
    return refuse(
      "dispatch_in_flight",
      actor,
      "another github_review call for this dispatch is in progress",
      "wait for that call's outcome; a dispatch posts one verdict",
    );
  }
  try {
    return await reviewClaimedDispatch(deps, { repo, pr, commitId: commitIdRaw, event: reviewEvent, body, assignment });
  } finally {
    ledger.release(assignment.dispatchId);
  }
}

interface ClaimedRequest {
  repo: string;
  pr: number;
  commitId: string;
  event: ReviewEvent;
  body: string;
  assignment: DispatchAssignment;
}

/** The refusal for a dispatch that is already latched. */
function latchedRefusal(latched: DispatchLatch, actor: string): Outcome {
  if (latched === "posted") {
    return refuse(
      "already_posted",
      actor,
      "this dispatch's review has already been posted",
      "one verdict per dispatch: a further review needs a fresh dispatch from the host",
    );
  }
  return refuse(
    "reconcile_required",
    actor,
    latched === "reserved"
      ? "a previous attempt for this dispatch did not record its outcome; its review may exist"
      : "a previous post for this dispatch has an unknown external state",
    "the host must reconcile the dispatch (latch-admin reconcile), which checks GitHub and releases it only if no review exists",
  );
}

async function reviewClaimedDispatch(deps: HandlerDeps, req: ClaimedRequest): Promise<Outcome> {
  const { config, custody, github, pendingAudits, ledger, runtime, clock, newId } = deps;
  const { repo, pr, event, body, assignment } = req;
  const actor = assignment.reviewer;
  const dispatchId = assignment.dispatchId;

  // ── a latched dispatch refuses until the host reconciles it ──
  let latched: DispatchLatch | null;
  try {
    latched = ledger.latchOf(dispatchId);
  } catch {
    return storeUnavailable(actor);
  }
  if (latched) return latchedRefusal(latched, actor);

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
      "store_unconfigured",
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

  // ── both durable stores must be usable NOW, before any request ──
  try {
    pendingAudits.probe();
    ledger.probe();
  } catch {
    return storeUnavailable(actor);
  }

  // ── host-authoritative PR lookup: open + head equality ──
  const lookupPull = await github.fetchPull(repo, pr);
  if (!lookupPull.ok) {
    return refuse("pr_unavailable", actor, lookupPull.detail, "retry once the PR is reachable");
  }
  if (lookupPull.pull.state !== "open") {
    return refuse("pr_not_open", actor, `PR ${repo}#${pr} is ${lookupPull.pull.state}`, "review open pull requests only");
  }
  const head = lookupPull.pull.head;
  if (req.commitId !== head || assignment.reviewedCommit !== head) {
    return refuse(
      "commit_mismatch",
      actor,
      "the submitted commit, the reviewed commit and the current head do not agree",
      "re-review the current head",
    );
  }

  // ── everything fallible is prepared BEFORE the reservation and the POST ──
  const bodySha256 = sha256Hex(Buffer.from(body, "utf8"));
  const auditEventId = newId();
  const createdAt = clock().toISOString();

  // ── the durable reservation is a PREREQUISITE to posting ──
  let existing: DispatchLatch | null;
  try {
    existing = ledger.reserve(dispatchId, { repo, pr, commit: head, login: scope.login, reservedAt: createdAt });
  } catch {
    return storeUnavailable(actor);
  }
  if (existing) return latchedRefusal(existing, actor);

  // ── post. A throw here is not a definitive answer: the review may exist. ──
  let posted: Awaited<ReturnType<GitHubApi["createReview"]>>;
  try {
    posted = await github.createReview({ repo, pr, commitId: head, event, body });
  } catch {
    posted = { ok: false, kind: "ambiguous", detail: "posting failed with no definitive response" };
  }

  // ── from here on nothing throws ──
  try {
    if (!posted.ok) {
      if (posted.kind === "rejected") {
        // A definitive rejection: no review was created, so the reservation goes.
        if (!ledger.unreserve(dispatchId)) {
          safeLog(
            deps,
            `openclaw-github-review: the reservation for dispatch ${dispatchId} could not be removed after GitHub rejected the review; ` +
              "the dispatch refuses with reconcile_required until the host reconciles it (latch-admin reconcile).",
          );
        }
        return refuse("github_rejected", actor, posted.detail, "correct the review and retry");
      }
      // AMBIGUOUS: a review may exist. Report an UNKNOWN state, never a refusal.
      settleLatch(deps, dispatchId, "reconcile_required", {});
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

    // A 2xx means the review EXISTS: `posted` for a validated receipt (its one
    // verdict), `reconcile_required` for one that does not match the request.
    const receiptValid = receipt.commitId === head && receipt.state === expectedReceiptState(event);
    settleLatch(deps, dispatchId, receiptValid ? "posted" : "reconcile_required", { reviewId: receipt.id });

    const draft = buildOrgEvent({
      id: auditEventId,
      reviewer: actor,
      repo,
      pr,
      commitId: head,
      event,
      bodySha256,
      receipt,
      sessionCorrelationId: dispatchId,
      runtime,
      login: scope.login,
      createdAt,
    });
    // The review exists either way, so the audit record is written (or retained)
    // even for a receipt that did not validate.
    const auditState = await recordAudit(deps, draft, `review ${receipt.id} on ${repo}#${pr}`);

    if (!receiptValid) {
      return {
        ok: true,
        status: "unknown",
        reason: "receipt_invalid",
        reviewId: receipt.id,
        reviewUrl: receipt.url,
        commitId: head,
        auditEventId: auditState === "acknowledged" ? auditEventId : null,
        login: scope.login,
      };
    }
    // Complete success only when the audit write was acknowledged. A failed
    // audit is `posted_audit_pending` when retained for host-side retry and
    // `posted_audit_unretained` when even retention failed.
    const status =
      auditState === "acknowledged" ? "posted" : auditState === "retained" ? "posted_audit_pending" : "posted_audit_unretained";
    return {
      ok: true,
      status,
      reviewId: receipt.id,
      reviewUrl: receipt.url,
      commitId: head,
      auditEventId,
      login: scope.login,
    };
  } catch {
    // Not reachable by any known path; if it ever is, the most conservative
    // report: the review may exist, and the dispatch stays at least reserved.
    return {
      ok: true,
      status: "unknown",
      reason: "reconcile_required",
      reviewId: posted.ok ? posted.receipt.id : null,
      reviewUrl: posted.ok ? posted.receipt.url : null,
      commitId: req.commitId,
      auditEventId: null,
      login: scope.login,
    };
  }
}

/** Write ONE host log line; a failing logger is contained. */
function safeLog(deps: HandlerDeps, line: string): void {
  try {
    deps.log(line);
  } catch {
    // The log line is lost; the outcome is unaffected.
  }
}

/** Record a post's outcome latch. Never throws: when the write fails the
 *  durable reservation still holds the dispatch, and ONE host log line (no
 *  path) says so. */
function settleLatch(
  deps: HandlerDeps,
  dispatchId: string,
  latch: "posted" | "reconcile_required",
  details: { reviewId?: number },
): void {
  if (!deps.ledger.settle(dispatchId, latch, details)) {
    safeLog(
      deps,
      `openclaw-github-review: the ${latch} latch for dispatch ${dispatchId} could not be written; the dispatch stays reserved ` +
        "and refuses with reconcile_required until the host reconciles it (latch-admin reconcile).",
    );
  }
}

/** Write the audit record; on failure retain it for host-side retry. Never
 *  throws. When even retention fails, ONE host log line (no path) names the
 *  event so the host can record it. */
async function recordAudit(
  deps: HandlerDeps,
  draft: OrgEventDraft,
  subject: string,
): Promise<"acknowledged" | "retained" | "unretained"> {
  try {
    await deps.audit.record(draft);
    return "acknowledged";
  } catch {
    try {
      deps.pendingAudits.save(draft);
      return "retained";
    } catch {
      safeLog(
        deps,
        `openclaw-github-review: audit record ${draft.id} (${subject}) was not acknowledged and could not be retained for retry; ` +
          "record it on the host.",
      );
      return "unretained";
    }
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
