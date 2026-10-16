/**
 * pr-review-trigger.ts — Listens for pr.opened OrgEvents and auto-requests K&S review.
 *
 * When an agent opens a PR (publishes pr.opened OrgEvent with detail=PR URL),
 * this trigger calls `gh-as <agentId> api` to request reviews from the configured
 * reviewer list.
 *
 * `startReviewTriggerLoop` runs it as its own loop over the agent's feed, with a
 * cursor file separate from the task loop's. `handlePrOpened` refuses (throws)
 * when the event carries no PR number or the review request fails, so the loop
 * retries the event instead of marking it done and advancing its cursor.
 */

import { spawnSync } from "node:child_process";
import snooplogg from "snooplogg";
import type { FlairClient } from "./flair-client.js";
import { startTaskLoop } from "./flair-task-loop.js";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:github");


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
 * Validate an agent's raw `reviewTrigger` config and reduce it to the loop's
 * `{ reviewers, repo }`. Returns undefined when the key is absent, and refuses
 * (throws) a value that is present but malformed. `agentId` is the runtime's
 * own, not config.
 */
export function parseReviewTriggerConfig(raw: unknown): { reviewers: string[]; repo: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidReviewTriggerConfigError("it must be a mapping with `reviewers` and `repo`");
  }
  const { reviewers, repo } = raw as { reviewers?: unknown; repo?: unknown };
  if (!Array.isArray(reviewers) || reviewers.length === 0 || !reviewers.every((r) => typeof r === "string" && r.length > 0)) {
    throw new InvalidReviewTriggerConfigError("`reviewers` must be a non-empty list of GitHub usernames");
  }
  if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new InvalidReviewTriggerConfigError("`repo` must be an owner/name string");
  }
  return { reviewers, repo };
}

/**
 * Extract PR number from a GitHub PR URL.
 * e.g. "https://github.com/tpsdev-ai/cli/pull/131" → 131
 */
function extractPrNumber(detail: string): number | null {
  const match = detail.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
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
  const { reviewers, agentId, repo } = config;
  if (reviewers.length === 0) return true;
  const runSync = deps.spawnSyncImpl ?? spawnSync;

  const body = JSON.stringify({ reviewers });
  const result = runSync(
    "gh-as",
    [agentId, "api", "--method", "POST", `repos/${repo}/pulls/${prNumber}/requested_reviewers`, "--input", "-"],
    { input: body, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    swarn(`[pr-review-trigger] Failed to request reviews for PR #${prNumber}: ${result.stderr?.trim()}`);
    return false;
  }
  slog(`[pr-review-trigger] Requested review on PR #${prNumber} from: ${reviewers.join(", ")}`);
  return true;
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
 * Handle a pr.opened OrgEvent: extract PR URL and request reviews. Throws when
 * the event carries no PR number or the review request fails, so the task loop
 * retries the event rather than marking it done.
 */
export async function handlePrOpened(
  event: { detail?: string; summary: string; refId?: string },
  config: ReviewTriggerConfig,
  deps: ReviewRequestDeps = {},
): Promise<void> {
  const detail = event.detail ?? "";
  const prNumber = extractPrNumber(detail);

  if (!prNumber) {
    throw new Error(`[pr-review-trigger] No PR number in event detail: ${detail || "(empty)"}`);
  }

  if (!requestReviews(prNumber, config, deps)) {
    throw new Error(`[pr-review-trigger] Review request failed for PR #${prNumber}`);
  }
}

/**
 * Poll the agent's own feed for `pr.opened`, using a different cursor filename from the task loop.
 * The loop ID allows the CLI's 64-character agent ID plus `-review-trigger`.
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
    { kinds: ["pr.opened"], loopId: `${agentId}-review-trigger`, pollIntervalMs: opts.pollIntervalMs },
  );
}
