/**
 * latch-admin.ts — the HOST's commands for the dispatch latch store.
 *
 * A command-line program the host operator runs on the gateway host, as the
 * gateway's service user. It is not registered with OpenClaw and no
 * agent-invokable tool reaches it: the plugin registers exactly one verb,
 * `github_review`, which can set a latch but never release one.
 *
 *   node dist/src/latch-admin.js list      <reconcileFile>
 *   node dist/src/latch-admin.js reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>]
 *   node dist/src/latch-admin.js clear     <reconcileFile> <dispatchId>      (always refuses; see below)
 *
 * `reconcile` is the ONLY way to release a dispatch. For a `reserved` or
 * `reconcile_required` latch it
 *   1. verifies the GitHub credential from the plugin's configuration exactly
 *      as the plugin does (provisioning evidence, repository coverage);
 *   2. lists the pull request's reviews with that credential and looks for this
 *      dispatch's review: the review id from a 2xx receipt, or any review by
 *      the dispatch's login on the dispatch's commit. An incomplete listing
 *      changes nothing;
 *   3. RECORDS the result — a signed Flair OrgEvent (`kind:
 *      pr_review_reconciled`), or, when Flair does not acknowledge it, one line
 *      in a local audit log — and says which. If neither can be written,
 *      nothing changes;
 *   4. then latches the dispatch `posted` if a review exists, or releases it
 *      only if none does.
 * A `posted` latch is final and is never released. `clear` exists only to
 * refuse: it never changes the store.
 *
 * `<pluginConfig.json>` holds the plugin's configuration object — the same
 * keys as its `plugins.entries` config in the gateway (reconcileFile,
 * credentialFile, provisioningFile, signingKeyFile, reviewerIdentity,
 * flairUrl, …). The default local audit log is `<reconcileFile>.audit.jsonl`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "./audit.js";
import { resolveConfig } from "./config.js";
import { CredentialCustody } from "./credential.js";
import { appendJsonLine } from "./durable-file.js";
import { FlairHttpAuditSink } from "./flair-sink.js";
import { HttpGitHubApi } from "./github.js";
import type { GitHubReviewLister, OrgEventDraft } from "./types.js";

export const LATCH_ADMIN_USAGE = [
  "usage: latch-admin list      <reconcileFile>",
  "       latch-admin reconcile <pluginConfig.json> <dispatchId> [--audit-log <file>]",
  "       latch-admin clear     <reconcileFile> <dispatchId>   (refuses: use reconcile)",
].join("\n");

/** Injection points (tests). Production uses the global fetch and clock. */
export interface LatchAdminDeps {
  fetchImpl?: typeof fetch;
  lister?: GitHubReviewLister;
  clock?: () => Date;
  newId?: () => string;
}

type Line = (line: string) => void;

function operatorName(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

/** Run one latch-admin command. Returns the process exit code: 0 done,
 *  1 refused or failed (the store is unchanged unless the output says
 *  otherwise), 2 usage. */
export async function runLatchAdmin(argv: string[], out: Line, err: Line, deps: LatchAdminDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "list" && rest.length === 1) return list(rest[0]!, out, err);
  if (command === "clear" && rest.length === 2) return clear(rest[0]!, rest[1]!, out, err);
  if (command === "reconcile" && (rest.length === 2 || (rest.length === 4 && rest[2] === "--audit-log"))) {
    return reconcile(rest[0]!, rest[1]!, rest[3] ?? null, out, err, deps);
  }
  err(LATCH_ADMIN_USAGE);
  return 2;
}

function list(file: string, out: Line, err: Line): number {
  try {
    for (const e of new FileReconcileStore(file).list()) {
      out([e.dispatchId, e.latch, e.repo && e.pr ? `${e.repo}#${e.pr}` : "-", e.commit ?? "-"].join("\t"));
    }
    return 0;
  } catch (e) {
    err(`latch-admin: the latch store could not be read: ${(e as Error).message}`);
    return 1;
  }
}

function clear(file: string, dispatchId: string, out: Line, err: Line): number {
  let latch;
  try {
    latch = new FileReconcileStore(file).get(dispatchId);
  } catch (e) {
    err(`latch-admin: the latch store could not be read: ${(e as Error).message}`);
    return 1;
  }
  if (latch === null) {
    out(`no latch for ${dispatchId}`);
    return 0;
  }
  if (latch === "posted") {
    err(`latch-admin: refused: dispatch ${dispatchId} is latched posted, which is final; a further review needs a fresh dispatch`);
    return 1;
  }
  err(
    `latch-admin: refused: dispatch ${dispatchId} is latched ${latch}; release it with ` +
      "`latch-admin reconcile <pluginConfig.json> <dispatchId>`, which checks GitHub and records the result first",
  );
  return 1;
}

async function reconcile(
  configFile: string,
  dispatchId: string,
  auditLogArg: string | null,
  out: Line,
  err: Line,
  deps: LatchAdminDeps,
): Promise<number> {
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
  let entry;
  try {
    entry = store.entry(dispatchId);
  } catch (e) {
    err(`latch-admin: the latch store could not be read: ${(e as Error).message}`);
    return 1;
  }
  if (!entry) {
    out(`no latch for ${dispatchId}; nothing to reconcile`);
    return 0;
  }
  if (entry.latch === "posted") {
    err(`latch-admin: refused: dispatch ${dispatchId} is latched posted, which is final; a further review needs a fresh dispatch`);
    return 1;
  }
  const { repo, pr, commit, login } = entry;
  if (!repo || !pr || !commit || !login) {
    err(`latch-admin: refused: the ${entry.latch} latch for ${dispatchId} records no attempt details; reconcile it by hand`);
    return 1;
  }

  // 1. The same credential and scope gate the plugin uses, before any request.
  const { custody, detail } = CredentialCustody.load({
    credentialFile: config.credentialFile,
    provisioningFile: config.provisioningFile,
    maxAgeDays: config.provisioningMaxAgeDays,
    clock: deps.clock ?? (() => new Date()),
  });
  if (!custody.isReady()) {
    err(`latch-admin: the GitHub credential is not usable (${detail}); nothing changed`);
    return 1;
  }
  const scope = custody.verifyForRepo(repo);
  if (!scope.ok) {
    err(`latch-admin: the GitHub credential does not cover ${repo} (${scope.state}); nothing changed`);
    return 1;
  }

  // 2. Does this dispatch's review exist?
  const lister = deps.lister ?? new HttpGitHubApi({ custody, fetchImpl: deps.fetchImpl });
  const listing = await lister.listReviews(repo, pr);
  if (!listing.ok) {
    err(`latch-admin: could not determine whether a review exists (${listing.detail}); nothing changed`);
    return 1;
  }
  const matching = listing.reviews.filter(
    (r) => (typeof entry.reviewId === "number" && r.id === entry.reviewId) || (r.login === login && r.commitId === commit),
  );
  const exists = matching.length > 0;
  const action = exists ? "latched_posted" : "released";

  // 3. Record the result BEFORE changing anything.
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  const event: OrgEventDraft = {
    id: (deps.newId ?? randomUUID)(),
    authorId: config.reviewerIdentity ?? "",
    kind: "pr_review_reconciled",
    scope: repo,
    refId: String(pr),
    targetIds: [String(pr), commit],
    summary: `dispatch ${dispatchId} reconciled: ${exists ? "a review exists; latched posted" : "no review exists; released"}`,
    detail: JSON.stringify({
      dispatch_id: dispatchId,
      repo,
      pr,
      commit_id: commit,
      latch_before: entry.latch,
      review_exists: exists,
      matching_reviews: matching.map((r) => ({ id: r.id, state: r.state, url: r.url })),
      reviews_listed: listing.reviews.length,
      action,
      dispatch_login: login,
      credential_login: scope.login,
      actor: "host:latch-admin",
      operator: operatorName(),
      checked_at: now,
    }),
    createdAt: now,
  };
  const auditLog = auditLogArg ?? `${config.reconcileFile}.audit.jsonl`;
  let recorded: string;
  let flairFailure: string;
  try {
    if (!config.signingKeyFile || !config.reviewerIdentity) throw new Error("no signing key or reviewer identity is configured");
    const sink = new FlairHttpAuditSink(config.reviewerIdentity, config.flairUrl, config.signingKeyFile, deps.fetchImpl ?? fetch);
    await sink.record(event);
    recorded = `audit: signed Flair OrgEvent ${event.id} (pr_review_reconciled) acknowledged`;
  } catch (e) {
    flairFailure = (e as { code?: unknown }).code ? String((e as { code?: unknown }).code) : (e as Error).message;
    try {
      appendJsonLine(auditLog, { recorded_at: now, flair_failure: flairFailure, event });
    } catch (e2) {
      err(
        `latch-admin: Flair did not acknowledge the reconciliation (${flairFailure}) and the local audit log ${auditLog} ` +
          `could not be written (${(e2 as Error).message}); nothing changed`,
      );
      return 1;
    }
    recorded = `audit: Flair did not acknowledge (${flairFailure}); recorded in the local audit log ${auditLog} (event ${event.id})`;
  }

  // 4. Only now change the latch.
  try {
    if (exists) store.add(dispatchId, "posted", { reviewId: matching[0]!.id });
    else store.clear(dispatchId);
  } catch (e) {
    out(recorded);
    err(`latch-admin: the result was recorded but the latch store could not be updated: ${(e as Error).message}`);
    return 1;
  }
  out(
    exists
      ? `dispatch ${dispatchId}: ${matching.length} matching review(s) (${matching.map((r) => r.id).join(", ")}); latched posted`
      : `dispatch ${dispatchId}: no review by ${login} on ${commit} among ${listing.reviews.length} review(s); released`,
  );
  out(recorded);
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
