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
 * EXACTLY ONE VERDICT PER DISPATCH: a dispatch whose review exists is latched
 * `posted` and refuses every later call with `already_posted`; a dispatch whose
 * post has an unknown external state is latched `reconcile_required`; and while
 * one call for a dispatch is in flight a second is refused with
 * `dispatch_in_flight`. The tool also declares `executionMode: "sequential"`,
 * which OpenClaw's runner uses to serialize a batch that contains it — the
 * in-flight guard does not depend on that.
 */

import { createHash } from "node:crypto";
import { buildOrgEvent } from "./audit.js";
import type { CredentialCustody } from "./credential.js";
import type { DispatchLedger } from "./dispatch-ledger.js";
import {
  REVIEW_EVENTS,
  type AssignmentResolver,
  type AuditSink,
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
  const { config, custody, assignments, github, pendingAudits, ledger, runtime, clock, newId } = deps;

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

  // ── a latched dispatch refuses until the host clears it ──
  let latched: DispatchLatch | null;
  try {
    latched = ledger.latchOf(assignment.dispatchId);
  } catch {
    return storeUnavailable(actor);
  }
  if (latched === "posted") {
    return refuse(
      "already_posted",
      actor,
      "this dispatch's review has already been posted",
      "one verdict per dispatch: a further review needs a fresh dispatch from the host",
    );
  }
  if (latched === "reconcile_required") {
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

  // ── one call per dispatch at a time. Everything from the latch check to
  //    this claim is synchronous, so two calls cannot both get past it. ──
  if (!ledger.claim(assignment.dispatchId)) {
    return refuse(
      "dispatch_in_flight",
      actor,
      "another github_review call for this dispatch is in progress",
      "wait for that call's outcome; a dispatch posts one verdict",
    );
  }
  try {
    // ── host-authoritative PR lookup: open + head equality ──
    const lookupPull = await github.fetchPull(repo, pr);
    if (!lookupPull.ok) {
      return refuse("pr_unavailable", actor, lookupPull.detail, "retry once the PR is reachable");
    }
    if (lookupPull.pull.state !== "open") {
      return refuse("pr_not_open", actor, `PR ${repo}#${pr} is ${lookupPull.pull.state}`, "review open pull requests only");
    }
    const head = lookupPull.pull.head;
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
      latchDispatch(deps, assignment.dispatchId, "reconcile_required");
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

    // A 2xx means the review EXISTS. Latch the dispatch before anything else can
    // fail: `posted` for a validated receipt (its one verdict), and
    // `reconcile_required` for a receipt that does not match the request.
    const receiptValid = receipt.commitId === head && receipt.state === expectedReceiptState(reviewEvent);
    latchDispatch(deps, assignment.dispatchId, receiptValid ? "posted" : "reconcile_required");

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
  } finally {
    ledger.release(assignment.dispatchId);
  }
}

/** Latch a dispatch after a post. Never throws: a latch the durable store
 *  cannot take is held in memory and ONE host log line (no path) says so. */
function latchDispatch(deps: HandlerDeps, dispatchId: string, latch: DispatchLatch): void {
  if (!deps.ledger.latch(dispatchId, latch)) {
    deps.log(
      `openclaw-github-review: the ${latch} latch for dispatch ${dispatchId} could not be written to the durable store; ` +
        "it is held in memory until the gateway restarts. Repair the store and record the latch before restarting.",
    );
  }
}

/** Write the audit record; on failure retain it for host-side retry. Never
 *  throws after a post. When even retention fails, ONE host log line (no path)
 *  names the event so the host can record it. */
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
      deps.log(
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
