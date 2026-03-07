/**
 * pr-review-trigger.ts — Listens for pr.opened OrgEvents and auto-requests K&S review.
 *
 * When an agent opens a PR (publishes pr.opened OrgEvent with detail=PR URL),
 * this trigger calls `gh-as <agentId> api` to request reviews from the configured
 * reviewer list.
 *
 * Designed to run inside Anvil's task loop as a second kind handler.
 */

import { spawnSync } from "node:child_process";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:github");


export interface ReviewTriggerConfig {
  reviewers: string[];   // GitHub usernames to request review from
  agentId: string;       // gh-as identity (e.g. "anvil")
  repo: string;          // owner/repo (e.g. "tpsdev-ai/cli")
}
export interface ReviewRequestDeps {
  spawnSyncImpl?: typeof spawnSync;
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
 * Handle a pr.opened OrgEvent: extract PR URL and request reviews.
 */
export async function handlePrOpened(
  event: { detail?: string; summary: string; refId?: string },
  config: ReviewTriggerConfig,
): Promise<void> {
  const detail = event.detail ?? "";
  const prNumber = extractPrNumber(detail);

  if (!prNumber) {
    swarn(`[pr-review-trigger] No PR number in event detail: ${detail}`);
    return;
  }

  requestReviews(prNumber, config);
}
