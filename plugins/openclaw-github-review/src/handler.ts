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
 * AT MOST ONE VERDICT PER DISPATCH, for the processes sharing the latch
 * store's lock (dispatch-ledger.ts, store-lock.ts): before the review is
 * POSTed the dispatch is CLAIMED — a durable `reserved` entry with this call's
 * claim, written by an atomic check-and-write under the store lock. If that
 * fails nothing is posted. A validated receipt settles it `posted` (every
 * later call: `already_posted`); an uncertain outcome settles it
 * `reconcile_required`; a response that PROVES no review was created
 * (github.ts) removes it — the ONLY release. Any other latch refuses every
 * call: the host's reconciliation can only confirm `posted` from a recorded
 * receipt, and a further review is a fresh dispatch. The tool also declares `executionMode:
 * "sequential"`; the guards do not depend on it.
 *
 * NO THROW AFTER THE POST: the fallible metadata (event id, timestamp,
 * digest) is prepared before the claim; the POST's result is read once into
 * checked primitives; every later step is contained; and the last-resort
 * fallback uses only values captured before the POST or from that snapshot.
 */

import { createHash } from "node:crypto";
import { reachablePath, readHostKey, validateApprovalEvidence, type ApprovalEvidenceLookup, type ApprovalEvidenceStore } from "./approval-evidence.js";
import { buildOrgEvent } from "./audit.js";
import type { CredentialCustody } from "./credential.js";
import type { DispatchLedger } from "./dispatch-ledger.js";
import { StoreLockBusyError } from "./store-lock.js";
import {
  REVIEW_EVENTS,
  type AssignmentResolver,
  type AuditSink,
  type DispatchAssignment,
  type DispatchLatch,
  type GitHubApi,
  type LatchRecord,
  type OrgEventDraft,
  type Outcome,
  type PendingAuditStore,
  type RefusalReason,
  type ReviewReceipt,
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
  /** The host-only store of the review-build evidence `APPROVE` requires. */
  approvalEvidence: ApprovalEvidenceStore;
  runtime: RuntimeEvidence;
  clock: () => Date;
  newId: () => string;
  /** Writes one host log line (may fail; callers contain it). Callers never
   *  pass a path or a secret. */
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

  // ── one call per dispatch at a time in this process, entered before the
  //    first await; across processes the durable claim decides (below). ──
  if (!ledger.enter(assignment.dispatchId)) return inFlightRefusal(actor);
  try {
    return await reviewClaimedDispatch(deps, { repo, pr, commitId: commitIdRaw, event: reviewEvent, body, assignment });
  } finally {
    try {
      ledger.leave(assignment.dispatchId);
    } catch {
      // Leaving the in-process set cannot change the outcome already decided.
    }
  }
}

function inFlightRefusal(actor: string): Outcome {
  return refuse(
    "dispatch_in_flight",
    actor,
    "another github_review call holds this dispatch's claim (in this or another gateway process), or one stopped without recording its outcome",
    "wait for that call's outcome; if none is running, the dispatch stays latched: a further review needs a fresh dispatch from the host",
  );
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
function latchedRefusal(record: LatchRecord, actor: string): Outcome {
  const latched = record.latch;
  if (latched === "reserved" && record.claim) return inFlightRefusal(actor);
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
    "the dispatch stays latched (the host's latch-admin reconcile only confirms a recorded receipt): a further review needs a fresh dispatch from the host",
  );
}

/** `APPROVE`'s evidence gate (approval-evidence.ts). Returns the record's
 *  digest, or the refusal. `REQUEST_CHANGES` and `COMMENT` never call it. */
function approvalEvidenceGate(
  deps: HandlerDeps,
  binding: { repo: string; pr: number; dispatchId: string; reviewer: string; sessionKey: string; commit: string },
): { ok: true; digest: string } | { ok: false; refusal: Outcome } {
  const actor = binding.reviewer;
  const { approvalEvidenceFile, approvalEvidenceKeyFile, approvalCiWorkflow, approvalCiJob, sandboxMountRoots } = deps.config;
  if (!approvalEvidenceFile || !approvalEvidenceKeyFile || !approvalCiWorkflow || !approvalCiJob || sandboxMountRoots.length === 0) {
    return {
      ok: false,
      refusal: refuse(
        "approval_evidence_unconfigured",
        actor,
        "the approval-evidence file, host key, CI workflow and job, and sandbox mount roots are not all configured",
        "configure approvalEvidenceFile, approvalEvidenceKeyFile, approvalCiWorkflow, approvalCiJob and sandboxMountRoots on the host before approving",
      ),
    };
  }
  let reachable: { path: string; root: string } | null;
  try {
    reachable = reachablePath([approvalEvidenceFile, approvalEvidenceKeyFile], sandboxMountRoots);
  } catch {
    reachable = { path: "", root: "" };
  }
  if (reachable) {
    return {
      ok: false,
      refusal: refuse(
        "approval_evidence_reachable",
        actor,
        "the approval-evidence file or host key is not shown to be outside every sandbox mount root",
        "move approvalEvidenceFile and approvalEvidenceKeyFile outside every path in sandboxMountRoots, with one link each",
      ),
    };
  }
  let key: Buffer;
  try {
    key = readHostKey(approvalEvidenceKeyFile);
  } catch {
    return {
      ok: false,
      refusal: refuse("approval_evidence_invalid", actor, "the approval-evidence host key could not be read", "repair the approval-evidence key file on the host"),
    };
  }
  let lookup: ApprovalEvidenceLookup;
  try {
    lookup = deps.approvalEvidence.find(binding);
  } catch {
    return {
      ok: false,
      refusal: refuse("approval_evidence_invalid", actor, "the approval-evidence store could not be read", "repair the approval-evidence file on the host"),
    };
  }
  if (lookup.status === "missing") {
    return {
      ok: false,
      refusal: refuse(
        "approval_evidence_missing",
        actor,
        "no approval evidence is recorded for this repository, PR, dispatch, reviewer, session and commit",
        "run the review build on the host and record its evidence before approving",
      ),
    };
  }
  if (lookup.status !== "found" && lookup.status !== "mismatch") {
    return {
      ok: false,
      refusal: refuse(
        "approval_evidence_invalid",
        actor,
        "the approval-evidence store does not resolve to exactly one record",
        "repair the approval-evidence file on the host",
      ),
    };
  }
  const verdict = validateApprovalEvidence(lookup.record, binding, { workflow: approvalCiWorkflow, job: approvalCiJob }, key);
  if (!verdict.ok) return { ok: false, refusal: refuse(verdict.reason, actor, verdict.state, verdict.remedy) };
  return { ok: true, digest: verdict.digest };
}

async function reviewClaimedDispatch(deps: HandlerDeps, req: ClaimedRequest): Promise<Outcome> {
  const { config, custody, github, pendingAudits, ledger, runtime, clock, newId } = deps;
  const { repo, pr, event, body, assignment } = req;
  const actor = assignment.reviewer;
  const dispatchId = assignment.dispatchId;

  // ── a latched dispatch refuses until the host reconciles it ──
  let latched: LatchRecord | null;
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

  // ── APPROVE requires the evidence record (approvalEvidenceGate). ──
  let approvalEvidenceSha256: string | null = null;
  if (event === "APPROVE") {
    const evidence = approvalEvidenceGate(deps, {
      repo,
      pr,
      dispatchId: assignment.dispatchId,
      reviewer: actor,
      sessionKey: assignment.sessionKey,
      commit: head,
    });
    if (!evidence.ok) return evidence.refusal;
    approvalEvidenceSha256 = evidence.digest;
  }

  // ── everything fallible is prepared BEFORE the claim and the POST ──
  const bodySha256 = sha256Hex(Buffer.from(body, "utf8"));
  const auditEventId = newId();
  const createdAt = clock().toISOString();
  const credentialSha256 = custody.bindingSha256();
  const login = scope.login;
  if (credentialSha256 === null) {
    return refuse("credential_unavailable", actor, "no usable GitHub credential is loaded", "install a fine-grained token + provisioning evidence and restart");
  }

  // ── the durable CLAIM is a prerequisite to posting ──
  let existing: LatchRecord | null;
  try {
    existing = ledger.reserve(dispatchId, { repo, pr, commit: head, login, credentialSha256, reservedAt: createdAt }, createdAt);
  } catch (err) {
    if (err instanceof StoreLockBusyError) safeLog(deps, `openclaw-github-review: ${err.pathFree("reconcileFile")}.`);
    return storeUnavailable(actor);
  }
  if (existing) return latchedRefusal(existing, actor);

  // ── post. A throw here is not a definitive answer: the review may exist. ──
  let posted: unknown;
  try {
    posted = await github.createReview({ repo, pr, commitId: head, event, body });
  } catch {
    posted = null;
  }

  // ── from here on nothing throws. `receiptId`/`receiptUrl` are primitives
  //    the last-resort fallback may use; nothing reads `posted` twice. ──
  let receiptId: number | null = null;
  let receiptUrl: string | null = null;
  try {
    const result = snapshotPostResult(posted);
    if (result.kind === "rejected") {
      // A response that PROVES no review was created: the reservation goes.
      if (!ledger.unreserve(dispatchId)) {
        safeLog(
          deps,
          `openclaw-github-review: the reservation for dispatch ${dispatchId} could not be removed after a response proving no review was ` +
            "created; it stays reserved with this call's claim, and refuses every call: a further review needs a fresh dispatch.",
        );
      }
      return refuse("github_rejected", actor, result.detail, "correct the review and retry");
    }
    if (result.kind === "ambiguous") {
      // AMBIGUOUS: a review may exist. Report an UNKNOWN state, never a refusal.
      // No receipt, so no audit record can be built.
      settleLatch(deps, dispatchId, "reconcile_required", {});
      return unknownOutcome(head, login, null, null, null);
    }
    if (result.kind === "unreadable_receipt") {
      // A 2xx — the review EXISTS — whose receipt cannot be read in full. Keep
      // what could be read (the id lets the host's reconciliation match it);
      // without a full receipt no audit record can be built.
      receiptId = result.id;
      receiptUrl = result.url;
      settleLatch(deps, dispatchId, "reconcile_required", result.id === null ? {} : { reviewId: result.id });
      return { ok: true, status: "unknown", reason: "receipt_invalid", reviewId: result.id, reviewUrl: result.url, commitId: head, auditEventId: null, login };
    }
    receiptId = result.id;
    receiptUrl = result.url;
    const receipt: ReviewReceipt = { id: result.id, url: result.url, commitId: result.commitId, state: result.state };

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
      approvalEvidenceSha256,
      receipt,
      sessionCorrelationId: dispatchId,
      runtime,
      login,
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
        login,
      };
    }
    // Complete success only when the audit write was acknowledged. A failed
    // audit is `posted_audit_pending` when retained for host-side retry and
    // `posted_audit_unretained` when retention was not durably confirmed.
    const status =
      auditState === "acknowledged" ? "posted" : auditState === "retained" ? "posted_audit_pending" : "posted_audit_unretained";
    return { ok: true, status, reviewId: receipt.id, reviewUrl: receipt.url, commitId: head, auditEventId, login };
  } catch {
    // Reached only when an injected component throws (the production ledger,
    // stores, audit path and logger are contained). The review may exist: the
    // report uses only primitives captured before the POST or from the
    // one-time snapshot, and the dispatch keeps whatever latch it has — at
    // least the durable reservation with this call's claim.
    return unknownOutcome(head, login, receiptId, receiptUrl, null);
  }
}

function unknownOutcome(
  commitId: string,
  login: string,
  reviewId: number | null,
  reviewUrl: string | null,
  auditEventId: string | null,
): Outcome {
  return { ok: true, status: "unknown", reason: "reconcile_required", reviewId, reviewUrl, commitId, auditEventId, login };
}

type PostSnapshot =
  | { kind: "created"; id: number; url: string; commitId: string; state: string }
  | { kind: "unreadable_receipt"; id: number | null; url: string | null }
  | { kind: "rejected"; detail: string }
  | { kind: "ambiguous" };

/** Read one property; a getter that throws reads as `undefined`. */
function readField(o: unknown, key: string): unknown {
  try {
    return typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** Read the POST's result ONCE, field by field, into checked primitives.
 *  - a well-formed rejection → `rejected` (the client classified it: only a
 *    response proving non-creation is `rejected`, github.ts);
 *  - `ok: true` (a 2xx: the review exists) with a complete receipt →
 *    `created`, otherwise `unreadable_receipt` with whatever id/url could be
 *    read;
 *  - anything else, including a result that cannot be read → `ambiguous`. */
function snapshotPostResult(posted: unknown): PostSnapshot {
  const ok = readField(posted, "ok");
  if (ok === false) {
    const kind = readField(posted, "kind");
    const detail = readField(posted, "detail");
    if (kind === "rejected" && typeof detail === "string") return { kind: "rejected", detail };
    return { kind: "ambiguous" };
  }
  if (ok !== true) return { kind: "ambiguous" };
  const receipt = readField(posted, "receipt");
  const id = readField(receipt, "id");
  const url = readField(receipt, "url");
  const commitId = readField(receipt, "commitId");
  const state = readField(receipt, "state");
  if (typeof id === "number" && typeof url === "string" && typeof commitId === "string" && typeof state === "string") {
    return { kind: "created", id, url, commitId, state };
  }
  return { kind: "unreadable_receipt", id: typeof id === "number" ? id : null, url: typeof url === "string" ? url : null };
}

/** ATTEMPT to write one host log line; a failing logger is ignored. */
function safeLog(deps: HandlerDeps, line: string): void {
  try {
    deps.log(line);
  } catch {
    // The log line is lost; the outcome is unaffected.
  }
}

/** Record a post's outcome latch. Never throws: when the write fails the
 *  durable reservation and its claim still hold the dispatch, and one host log
 *  line (no path) is attempted. */
function settleLatch(
  deps: HandlerDeps,
  dispatchId: string,
  latch: "posted" | "reconcile_required",
  details: { reviewId?: number },
): void {
  if (!deps.ledger.settle(dispatchId, latch, details)) {
    safeLog(
      deps,
      `openclaw-github-review: the ${latch} latch for dispatch ${dispatchId} could not be written; the dispatch stays reserved with ` +
        "this call's claim and refuses every call: a further review needs a fresh dispatch.",
    );
  }
}

/** Write the audit record; on failure retain it for host-side retry. Never
 *  throws. When retention is not durably confirmed, one host log line (no path) naming the
 *  event is attempted so the host can record it. */
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
        `openclaw-github-review: audit record ${draft.id} (${subject}) was not acknowledged and its retention for retry was not ` +
          "durably confirmed; check pendingAuditFile and record it on the host if it is absent.",
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
