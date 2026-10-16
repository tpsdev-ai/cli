/**
 * pr-review-trigger.ts — Listens for pr.opened OrgEvents and auto-requests K&S review.
 *
 * When an agent opens a PR (publishes pr.opened OrgEvent with detail=PR URL),
 * this trigger calls `gh-as <agentId> api` to request reviews from the configured
 * reviewer list, on the repository named by the event's own PR URL.
 *
 * `startReviewTriggerLoop` runs it as its own loop over the agent's feed, with a
 * cursor file separate from the task loop's, acting only on events the agent
 * itself authored. `handlePrOpened` throws `PermanentEventError` for a failure a
 * retry cannot fix (a detail that names no repository, a 404/422 from gh) and an
 * ordinary error for a transient one, so the loop skips the former and retries
 * the latter within the attempt bound.
 */

import { spawnSync } from "node:child_process";
import snooplogg from "snooplogg";
import type { FlairClient } from "./flair-client.js";
import { PermanentEventError, startTaskLoop } from "./flair-task-loop.js";
const { log: slog, warn: swarn } = snooplogg("tps:github");

/** Maximum total attempts per event, including the initial request. */
export const REVIEW_TRIGGER_MAX_ATTEMPTS = 3;


export interface ReviewTriggerConfig {
  reviewers: string[];   // GitHub usernames to request review from
  agentId: string;       // gh-as identity (e.g. "anvil")
  repo: string;          // owner/repo (e.g. "tpsdev-ai/cli")
}
export interface ReviewRequestDeps {
  spawnSyncImpl?: typeof spawnSync;
}

/** Thrown for a malformed `reviewTrigger` in an agent's config. */
export class InvalidReviewTriggerConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid reviewTrigger config: ${reason}`);
    this.name = "InvalidReviewTriggerConfigError";
  }
}

/**
 * Validate an agent's `reviewTrigger` property. An absent key disables the loop;
 * invalid values throw.
 */
export function parseReviewTriggerConfig(config: { reviewTrigger?: unknown }): { reviewers: string[]; repo: string } | undefined {
  if (!Object.hasOwn(config, "reviewTrigger")) return undefined;
  const raw = config.reviewTrigger;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidReviewTriggerConfigError("it must be a mapping with `reviewers` and `repo`");
  }
  const { reviewers, repo } = raw as { reviewers?: unknown; repo?: unknown };
  if (!Array.isArray(reviewers) || reviewers.length === 0 || !reviewers.every((r) => typeof r === "string" && r.trim().length > 0)) {
    throw new InvalidReviewTriggerConfigError("`reviewers` must be a non-empty list of GitHub usernames");
  }
  if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new InvalidReviewTriggerConfigError("`repo` must be an owner/name string");
  }
  return { reviewers, repo };
}

/**
 * The repository and number a GitHub PR URL names, or null when `detail` is not
 * one. The owner and name are validated as `[A-Za-z0-9._-]+` components.
 * e.g. "https://github.com/tpsdev-ai/cli/pull/131" → { repo: "tpsdev-ai/cli", number: 131 }
 */
export function parsePrUrl(detail: string): { repo: string; number: number } | null {
  const match = detail
    .trim()
    .match(/^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

/** The HTTP status gh reports in stderr (e.g. "gh: Not Found (HTTP 404)"), or null when it reports none. */
function ghHttpStatus(stderr: string): number | null {
  const match = stderr.match(/\bHTTP\s+(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Whether a failed `gh-as api` call is permanent: a 404 (a missing repository or
 * PR) or a 422 (an invalid reviewer), the two a review request is refused with
 * and that a retry cannot fix. A network error, a 5xx or a rate limit is
 * transient.
 */
export function isPermanentGhFailure(stderr: string): boolean {
  const status = ghHttpStatus(stderr);
  return status === 404 || status === 422;
}

interface ReviewRequestOutcome {
  ok: boolean;
  /** For a failure, whether a retry cannot succeed. */
  permanent: boolean;
  /** For a failure, a short reason for the log. */
  reason: string;
}

/** Attempt the review request once and report whether a failure may be retried. */
function attemptRequestReviews(
  repo: string,
  prNumber: number,
  reviewers: string[],
  config: ReviewTriggerConfig,
  deps: ReviewRequestDeps,
): ReviewRequestOutcome {
  if (reviewers.length === 0) return { ok: true, permanent: false, reason: "" };
  const runSync = deps.spawnSyncImpl ?? spawnSync;

  const result = runSync(
    "gh-as",
    [config.agentId, "api", "--method", "POST", `repos/${repo}/pulls/${prNumber}/requested_reviewers`, "--input", "-"],
    { input: JSON.stringify({ reviewers }), encoding: "utf-8" },
  );

  if (result.status !== 0) {
    const reason = result.stderr?.trim() || `gh-as exit ${result.status}`;
    swarn(`[pr-review-trigger] Failed to request reviews for PR #${prNumber}: ${reason}`);
    return { ok: false, permanent: isPermanentGhFailure(reason), reason };
  }
  slog(`[pr-review-trigger] Requested review on PR #${prNumber} from: ${reviewers.join(", ")}`);
  return { ok: true, permanent: false, reason: "" };
}

/**
 * Request reviews on a PR via gh-as.
 * Returns true on success.
 */
export function requestReviews(
  prNumber: number,
  config: ReviewTriggerConfig,
  deps: ReviewRequestDeps = {},
): boolean {
  return attemptRequestReviews(config.repo, prNumber, config.reviewers, config, deps).ok;
}

export function reRequestReviewer(
  prNumber: number,
  reviewer: string,
  config: Omit<ReviewTriggerConfig, "reviewers">,
  deps: ReviewRequestDeps = {},
): boolean {
  return requestReviews(prNumber, { ...config, reviewers: [reviewer] }, deps);
}

/**
 * Handle a pr.opened OrgEvent: parse the PR URL and request reviews on that
 * repository. Throws `PermanentEventError` for a failure a retry cannot fix (no
 * PR URL or repository in `detail`, a URL naming another repository, a 404/422
 * from gh) and an ordinary error for a transient one, so the loop skips the
 * former and retries the latter.
 */
export async function handlePrOpened(
  event: { detail?: string; summary: string; refId?: string },
  config: ReviewTriggerConfig,
  deps: ReviewRequestDeps = {},
): Promise<void> {
  const detail = event.detail ?? "";
  const parsed = parsePrUrl(detail);

  if (!parsed) {
    throw new PermanentEventError(`No PR number in event detail: ${detail || "(empty)"}`);
  }

  if (config.repo && config.repo !== parsed.repo) {
    throw new PermanentEventError(`PR URL names ${parsed.repo}, not the configured ${config.repo}`);
  }

  const outcome = attemptRequestReviews(parsed.repo, parsed.number, config.reviewers, config, deps);
  if (!outcome.ok) {
    const message = `Review request failed for PR #${parsed.number}: ${outcome.reason}`;
    throw outcome.permanent ? new PermanentEventError(message) : new Error(message);
  }
}

/**
 * Poll the agent's own feed for `pr.opened` events the agent itself authored,
 * using a different cursor filename from the task loop. The loop ID allows the
 * CLI's 64-character agent ID plus `-review-trigger`.
 */
export function startReviewTriggerLoop(
  flair: FlairClient,
  agentId: string,
  config: { reviewers: string[]; repo: string },
  opts: { pollIntervalMs?: number; deps?: ReviewRequestDeps } = {},
): { stop: () => Promise<void> } {
  const triggerConfig: ReviewTriggerConfig = { reviewers: config.reviewers, agentId, repo: config.repo };
  return startTaskLoop(
    flair,
    agentId,
    async (event) => { await handlePrOpened(event, triggerConfig, opts.deps); },
    {
      kinds: ["pr.opened"],
      loopId: `${agentId}-review-trigger`,
      pollIntervalMs: opts.pollIntervalMs,
      authorId: agentId,
      maxAttempts: REVIEW_TRIGGER_MAX_ATTEMPTS,
    },
  );
}
