/**
 * latch-admin.ts — the HOST's commands for the dispatch latch store.
 *
 * A command-line program the host operator runs on the gateway host, as the
 * gateway's service user. It is not registered with OpenClaw and no
 * agent-invokable tool reaches it: the plugin registers exactly one verb,
 * `github_review`, which never releases a latch except after a response that
 * proves its own POST created nothing.
 *
 *   node dist/src/latch-admin.js list      <reconcileFile>
 *   node dist/src/latch-admin.js reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>] [--stale-claim]
 *   node dist/src/latch-admin.js clear     <reconcileFile> <dispatchId>      (always refuses; see below)
 *
 * `reconcile` NEVER RELEASES a dispatch: nothing independent can prove that a
 * POST which may have started created no review, and an empty listing is not
 * proof. It has two outcomes (see decideReconciliation): latch `posted` when
 * the attempt's RECORDED receipt id is listed, or leave the entry latched and
 * tell the operator to issue a FRESH dispatch (a new dispatchId) — the same
 * retry path as after a credential rotation. For a `reserved` or
 * `reconcile_required` latch it:
 *   1. refuses while the gateway's CLAIM is held (the attempt may be in
 *      flight). `--stale-claim` declares the claiming process gone; it is still
 *      refused when that process is alive on this host;
 *   2. refuses an attempt younger than RECONCILE_MIN_AGE_MS;
 *   3. loads the credential named by the configuration and REQUIRES it to be
 *      the one that made the attempt (its fingerprint, recorded with the
 *      attempt) with the attempt's login — a rotated or different credential
 *      is refused by name;
 *   4. lists the pull request's reviews with that credential (an incomplete
 *      listing changes nothing) and decides: `posted` when the recorded
 *      receipt id is listed, otherwise RETAIN;
 *   5. RECORDS the decision before changing anything — a signed Flair OrgEvent
 *      (`kind: pr_review_reconciled`), or, when Flair does not acknowledge it,
 *      an fsync'ed line in a local audit log (its directory fsync'ed before the
 *      append returns) — and says which. If neither can be written, nothing
 *      changes;
 *   6. applies a `posted` decision under the store lock, only if the entry is
 *      unchanged since step 1 (compare-and-swap).
 * A `posted` latch is final. `clear` exists only to refuse. The only release
 * of a dispatch anywhere is the handler's, on a response that proves its own
 * POST created nothing (github.ts).
 *
 * ATTRIBUTION. The plugin configures no host principal: the reconciliation
 * event is signed with the REVIEWER's Flair key (signingKeyFile) and its
 * authorId is the reviewer. The only operator identity this command knows is
 * the OS account running it (user, uid, host, pid), recorded as `invoked_by`.
 *
 * `<pluginConfig.json>` holds the plugin's configuration object — the same
 * keys as its `plugins.entries` config in the gateway. The default local audit
 * log is `<reconcileFile>.audit.jsonl`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "./audit.js";
import { resolveConfig } from "./config.js";
import { CredentialCustody } from "./credential.js";
import { appendJsonLine } from "./durable-file.js";
import { FlairHttpAuditSink } from "./flair-sink.js";
import { HttpGitHubApi } from "./github.js";
import { StoreLockBusyError } from "./store-lock.js";
import type { ExistingReview, GitHubReviewLister, LatchClaim, LatchDetails, LatchRecord, OrgEventDraft } from "./types.js";

export const LATCH_ADMIN_USAGE = [
  "usage: latch-admin list      <reconcileFile>",
  "       latch-admin reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>] [--stale-claim]",
  "       latch-admin clear     <reconcileFile> <dispatchId>   (refuses: use reconcile)",
].join("\n");

/** An attempt younger than this is not reconciled: a review it created may
 *  not be listed yet. */
export const RECONCILE_MIN_AGE_MS = 10 * 60_000;
/** Injection points (tests). Production uses the global fetch and clock. */
export interface LatchAdminDeps {
  fetchImpl?: typeof fetch;
  lister?: GitHubReviewLister;
  clock?: () => Date;
  newId?: () => string;
  /** Whether a pid is alive on this host (default: signal 0). */
  pidAlive?: (pid: number) => boolean;
}

type Line = (line: string) => void;

export type ReconcileDecision =
  | { decision: "latch_posted"; matching: ExistingReview[]; reasons: string[] }
  | { decision: "retain"; matching: []; reasons: string[] };

/** The operator's remedy for a dispatch that stays latched. */
export const FRESH_DISPATCH_REMEDY =
  "non-creation cannot be proven, so this dispatch stays latched: to review this pull request again, issue a FRESH dispatch (a new dispatchId)";

type Attempt = LatchRecord & LatchDetails;

/** Decide a reconciliation from a COMPLETE review listing read with the
 *  attempt's own credential. There are two outcomes and NO release:
 *  - `latch_posted` — the ONE proof: the review id recorded from the attempt's
 *    2xx receipt is in the listing (whatever its login or commit);
 *  - `retain` — everything else: an empty listing, an attempt that recorded no
 *    receipt id, a recorded id that is not listed, and a same-login,
 *    same-commit review without the recorded id (it may predate the attempt).
 *  `now` is kept for the record; age is enforced before listing. */
export function decideReconciliation(attempt: Attempt, reviews: ExistingReview[], _now: Date): ReconcileDecision {
  const created = typeof attempt.reviewId === "number" ? reviews.filter((r) => r.id === attempt.reviewId) : [];
  if (created.length > 0) {
    return {
      decision: "latch_posted",
      matching: created,
      reasons: created.map((r) => `review ${r.id} (${r.state}) is the one the attempt's 2xx receipt recorded`),
    };
  }
  const reasons: string[] = [];
  if (typeof attempt.reviewId === "number") {
    reasons.push(`the attempt's 2xx receipt recorded review ${attempt.reviewId}, but the listing does not return it`);
  } else {
    reasons.push("the attempt recorded no receipt id, so no listing can show what it created");
  }
  for (const r of reviews) {
    if (r.login === attempt.login && r.commitId === attempt.commit) {
      reasons.push(`review ${r.id} by ${r.login} on the attempt's commit may be the attempt's, but only the recorded receipt id proves it`);
    }
  }
  return { decision: "retain", matching: [], reasons };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. Anything else (EPERM: alive, not ours) → alive.
    return (err as { code?: unknown }).code !== "ESRCH";
  }
}

function invokedBy(): Record<string, unknown> {
  let user: string | null = null;
  let uid: number | null = null;
  try {
    const info = userInfo();
    user = info.username;
    uid = info.uid;
  } catch {
    // unknown
  }
  return {
    os_user: user,
    uid,
    host: hostname(),
    pid: process.pid,
    note: "the OS account running latch-admin: the only operator identity this command knows",
  };
}

/** Run one latch-admin command. Returns the process exit code: 0 done (the
 *  output says what changed), 1 refused, retained or failed (the store is
 *  unchanged unless the output says otherwise), 2 usage. */
export async function runLatchAdmin(argv: string[], out: Line, err: Line, deps: LatchAdminDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "list" && rest.length === 1) return list(rest[0]!, out, err);
  if (command === "clear" && rest.length === 2) return clear(rest[0]!, rest[1]!, out, err);
  if (command === "reconcile" && rest.length >= 2) {
    const [configFile, dispatchId, ...flags] = rest;
    let auditLog: string | null = null;
    let staleClaim = false;
    let usable = true;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--stale-claim") staleClaim = true;
      else if (flags[i] === "--audit-log" && flags[i + 1] !== undefined) auditLog = flags[++i]!;
      else usable = false;
    }
    if (usable) return reconcile(configFile!, dispatchId!, auditLog, staleClaim, out, err, deps);
  }
  err(LATCH_ADMIN_USAGE);
  return 2;
}

function describeClaim(claim: LatchClaim | undefined): string {
  return claim ? `claim held by pid ${claim.pid} on ${claim.host} since ${claim.at}` : "-";
}

function list(file: string, out: Line, err: Line): number {
  try {
    for (const e of new FileReconcileStore(file).list()) {
      out([e.dispatchId, e.latch, e.repo && e.pr ? `${e.repo}#${e.pr}` : "-", e.commit ?? "-", describeClaim(e.claim)].join("\t"));
    }
    return 0;
  } catch (e) {
    err(`latch-admin: the latch store could not be read: ${(e as Error).message}`);
    return 1;
  }
}

function clear(file: string, dispatchId: string, out: Line, err: Line): number {
  let entry: LatchRecord | null;
  try {
    entry = new FileReconcileStore(file).entry(dispatchId);
  } catch (e) {
    err(`latch-admin: the latch store could not be read: ${(e as Error).message}`);
    return 1;
  }
  if (entry === null) {
    out(`no latch for ${dispatchId}`);
    return 0;
  }
  if (entry.latch === "posted") {
    err(`latch-admin: refused: dispatch ${dispatchId} is latched posted, which is final; a further review needs a fresh dispatch`);
    return 1;
  }
  err(
    `latch-admin: refused: dispatch ${dispatchId} is latched ${entry.latch}; nothing releases it — ` +
      "`latch-admin reconcile <pluginConfig.json> <dispatchId>` latches it posted when its recorded receipt is listed; " +
      `otherwise ${FRESH_DISPATCH_REMEDY}`,
  );
  return 1;
}

function lockFailure(e: unknown, err: Line, what: string): number {
  if (e instanceof StoreLockBusyError) err(`latch-admin: ${what}: ${e.message}. ${e.remedy()}`);
  else err(`latch-admin: ${what}: ${(e as Error).message}`);
  return 1;
}

async function reconcile(
  configFile: string,
  dispatchId: string,
  auditLogArg: string | null,
  staleClaim: boolean,
  out: Line,
  err: Line,
  deps: LatchAdminDeps,
): Promise<number> {
  const clock = deps.clock ?? (() => new Date());
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (e) {
    err(`latch-admin: the plugin configuration could not be read: ${(e as Error).message}`);
    return 1;
  }
  const config = resolveConfig(raw, "latch-admin");
  if (!config.reconcileFile) {
    err("latch-admin: the plugin configuration has no reconcileFile");
    return 1;
  }
  const store = new FileReconcileStore(config.reconcileFile);
  let entry: LatchRecord | null;
  try {
    entry = store.entry(dispatchId);
  } catch (e) {
    return lockFailure(e, err, "the latch store could not be read");
  }
  if (!entry) {
    out(`no latch for ${dispatchId}; nothing to reconcile`);
    return 0;
  }
  if (entry.latch === "posted") {
    err(`latch-admin: refused: dispatch ${dispatchId} is latched posted, which is final; a further review needs a fresh dispatch`);
    return 1;
  }
  const { repo, pr, commit, login, credentialSha256, reservedAt } = entry;
  if (!repo || !pr || !commit || !login || !credentialSha256 || !reservedAt) {
    err(
      `latch-admin: refused: the ${entry.latch} latch for ${dispatchId} does not record the attempt's details (repo, pr, commit, login, ` +
        "credential fingerprint, time), so non-creation cannot be proven; it stays latched — a further review needs a fresh dispatch",
    );
    return 1;
  }
  const attempt = entry as Attempt;

  // 1. The gateway's claim: the attempt may be in flight.
  if (entry.claim) {
    if (!staleClaim) {
      err(
        `latch-admin: refused: dispatch ${dispatchId} has its ${describeClaim(entry.claim)}: the attempt may be in flight. ` +
          "If that process is gone (the gateway was stopped or restarted since), rerun with --stale-claim",
      );
      return 1;
    }
    if (entry.claim.host === hostname() && (deps.pidAlive ?? defaultPidAlive)(entry.claim.pid)) {
      err(`latch-admin: refused: --stale-claim, but the claiming process pid ${entry.claim.pid} is still running on this host`);
      return 1;
    }
  }

  // 2. Too recent to prove anything.
  const now = clock();
  const reservedMs = Date.parse(reservedAt);
  if (!Number.isFinite(reservedMs) || now.getTime() - reservedMs < RECONCILE_MIN_AGE_MS) {
    const after = Number.isFinite(reservedMs) ? new Date(reservedMs + RECONCILE_MIN_AGE_MS).toISOString() : "?";
    err(`latch-admin: refused: the attempt (reserved ${reservedAt}) is too recent to reconcile; retry after ${after}`);
    return 1;
  }

  // 3. The SAME credential and login that made the attempt.
  const { custody, detail } = CredentialCustody.load({
    credentialFile: config.credentialFile,
    provisioningFile: config.provisioningFile,
    maxAgeDays: config.provisioningMaxAgeDays,
    clock,
  });
  if (!custody.isReady()) {
    err(`latch-admin: the GitHub credential is not usable (${detail}); nothing changed`);
    return 1;
  }
  if (custody.bindingSha256() !== credentialSha256) {
    err(
      "latch-admin: refused (credential_mismatch): the credential this configuration loads is not the one that made the attempt " +
        "(it was rotated, or this is another configuration). Reconcile with the credential that made the attempt; if it is gone, " +
        "non-creation cannot be proven and the dispatch stays latched — a further review needs a fresh dispatch",
    );
    return 1;
  }
  const scope = custody.verifyForRepo(repo);
  if (!scope.ok) {
    err(`latch-admin: the GitHub credential does not cover ${repo} (${scope.state}); nothing changed`);
    return 1;
  }
  if (scope.login !== login) {
    err(
      `latch-admin: refused (login_mismatch): the credential's provisioning evidence names ${scope.login}, the attempt was made as ${login}; ` +
        "re-record the provisioning evidence for the attempt's credential, or leave the dispatch latched",
    );
    return 1;
  }

  // 4. List the reviews with that credential and decide.
  const lister = deps.lister ?? new HttpGitHubApi({ custody, fetchImpl: deps.fetchImpl });
  const listing = await lister.listReviews(repo, pr);
  if (!listing.ok) {
    err(`latch-admin: could not determine whether a review exists (${listing.detail}); nothing changed`);
    return 1;
  }
  const result = decideReconciliation(attempt, listing.reviews, now);

  // 5. Record the decision BEFORE changing anything.
  const at = now.toISOString();
  const event: OrgEventDraft = {
    id: (deps.newId ?? randomUUID)(),
    authorId: config.reviewerIdentity ?? "",
    kind: "pr_review_reconciled",
    scope: repo,
    refId: String(pr),
    targetIds: [String(pr), commit],
    summary: `host reconciliation of dispatch ${dispatchId}: ${result.decision}`,
    detail: JSON.stringify({
      dispatch_id: dispatchId,
      repo,
      pr,
      commit_id: commit,
      latch_before: entry.latch,
      receipt_review_id: entry.reviewId ?? null,
      decision: result.decision,
      reasons: result.reasons,
      matching_reviews: result.matching.map((r) => ({ id: r.id, state: r.state, url: r.url })),
      reviews_listed: listing.reviews.length,
      attempt_login: login,
      credential_matches_attempt: true,
      stale_claim_overridden: staleClaim && entry.claim ? entry.claim : null,
      signed_with: "the reviewer's Flair signing key (signingKeyFile); the plugin configures no host principal",
      invoked_by: invokedBy(),
      command: "latch-admin reconcile",
      checked_at: at,
    }),
    createdAt: at,
  };
  const auditLog = auditLogArg ?? `${config.reconcileFile}.audit.jsonl`;
  let recorded: string;
  try {
    if (!config.signingKeyFile || !config.reviewerIdentity) throw new Error("no signing key or reviewer identity is configured");
    const sink = new FlairHttpAuditSink(config.reviewerIdentity, config.flairUrl, config.signingKeyFile, deps.fetchImpl ?? fetch);
    await sink.record(event);
    recorded = `audit: Flair OrgEvent ${event.id} (pr_review_reconciled), signed with the reviewer's key, acknowledged`;
  } catch (e) {
    const flairFailure = (e as { code?: unknown }).code ? String((e as { code?: unknown }).code) : (e as Error).message;
    try {
      appendJsonLine(auditLog, { recorded_at: at, flair_failure: flairFailure, event });
    } catch (e2) {
      err(
        `latch-admin: Flair did not acknowledge the reconciliation (${flairFailure}) and the local audit log ${auditLog} ` +
          `could not be written (${(e2 as Error).message}); nothing changed`,
      );
      return 1;
    }
    recorded = `audit: Flair did not acknowledge (${flairFailure}); recorded (fsync'ed) in the local audit log ${auditLog} (event ${event.id})`;
  }

  if (result.decision === "retain") {
    out(recorded);
    err(`latch-admin: retained: dispatch ${dispatchId} stays ${entry.latch} (${result.reasons.join("; ")}); ${FRESH_DISPATCH_REMEDY}`);
    return 1;
  }

  // 6. Apply `posted` under the store lock, only if the entry is unchanged.
  let applied: boolean;
  try {
    const { claim: _dropped, ...rest } = entry;
    applied = store.replaceIf(dispatchId, entry, { ...rest, latch: "posted", reviewId: result.matching[0]!.id });
  } catch (e) {
    out(recorded);
    return lockFailure(e, err, "the decision was recorded but the latch store could not be updated");
  }
  out(recorded);
  if (!applied) {
    err(`latch-admin: the latch for ${dispatchId} changed during reconciliation; the decision was recorded but NOT applied — rerun`);
    return 1;
  }
  out(`dispatch ${dispatchId}: the recorded receipt's review ${result.matching[0]!.id} is listed; latched posted`);
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runLatchAdmin(
    process.argv.slice(2),
    (line) => console.log(line),
    (line) => console.error(line),
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`latch-admin: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
