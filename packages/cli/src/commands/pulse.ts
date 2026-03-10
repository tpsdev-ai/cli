/**
 * tps pulse start|status|list
 *
 * Phase 1: PR review lifecycle poll loop.
 * Polls GitHub for open PRs, tracks state transitions, sends TPS mail notifications.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFlairClient } from "../utils/flair-client.js";
import { gcMessages } from "../utils/mail.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrState = "opened" | "reviewing" | "changes-requested" | "approved" | "merged";

export interface HistoryEntry {
  at: string;
  from: PrState | null;
  to: PrState;
}

export interface PrInstance {
  state: PrState;
  prNumber: number;
  repo: string;
  title: string;
  author: string;
  reviewers: string[];
  lastTransitionAt: string;
  reminderSentAt: string | null;
  reviewRequestedAt?: string;
  lastRemindedAt?: string;
  escalatedAt?: string;
  mergeReadyNotifiedAt?: boolean;
  history: HistoryEntry[];
}

export interface PulseState {
  version: 1;
  lastPollAt: string;
  instances: Record<string, PrInstance>;
}

export interface PulseConfig {
  repos: string[];
  reviewers: string[];
  mergeAuthority: string;
  author: string;
  human: string;
  pollIntervalMs: number;
  remindAfterMs: number;
  ghAgent: string;
  pruneAfterDays: number;
  flairUrl?: string;
  flairAgentId?: string;
  flairAgentKey?: string;
}

// Injectable runner type for testing
export type SyncRunner = (cmd: string, args: string[], opts?: { encoding?: BufferEncoding; timeout?: number; env?: NodeJS.ProcessEnv }) => SpawnSyncReturns<string>;

// Injectable mail sender for testing
export type MailSender = (to: string, body: string, agentId: string) => void;

// Injectable Flair publisher for testing (null = disabled)
export type FlairPublisher = (
  key: string,
  from: PrState | null,
  to: PrState,
  instance: PrInstance,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PulseConfig = {
  repos: ["tpsdev-ai/cli", "tpsdev-ai/flair"],
  reviewers: ["sherlock", "kern"],
  mergeAuthority: "flint",
  author: "anvil",
  human: "nathan",
  pollIntervalMs: 120000,
  remindAfterMs: 1800000,
  ghAgent: "flint",
  pruneAfterDays: 7,
};

const PULSE_DIR = join(homedir(), ".tps", "pulse");
const CONFIG_PATH = join(PULSE_DIR, "config.json");
const STATE_PATH = join(PULSE_DIR, "state.json");

// ---------------------------------------------------------------------------
// Config & State I/O
// ---------------------------------------------------------------------------

export function loadConfig(): PulseConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULT_CONFIG, ...raw };
    } catch (e: unknown) {
      console.warn(`[pulse] Failed to parse config: ${(e as Error).message}, using defaults`);
    }
  }
  return { ...DEFAULT_CONFIG };
}

export function loadState(): PulseState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as PulseState;
    } catch (e: unknown) {
      console.warn(`[pulse] Failed to parse state: ${(e as Error).message}, starting fresh`);
    }
  }
  return { version: 1, lastPollAt: "", instances: {} };
}

export function saveState(state: PulseState): void {
  mkdirSync(PULSE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Remove terminal instances (merged/closed) older than pruneAfterDays.
 * Returns the number of instances pruned.
 */
export function pruneState(state: PulseState, pruneAfterDays: number): number {
  const cutoff = Date.now() - pruneAfterDays * 24 * 60 * 60 * 1000;
  const terminalStates = new Set<string>(["merged", "closed"]);
  let pruned = 0;
  for (const key of Object.keys(state.instances)) {
    const inst = state.instances[key];
    if (
      terminalStates.has(inst.state) &&
      new Date(inst.lastTransitionAt).getTime() < cutoff
    ) {
      delete state.instances[key];
      pruned++;
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

export function ghApi(endpoint: string, ghAgent: string, runner: SyncRunner = spawnSync as unknown as SyncRunner): unknown {
  const r = runner("gh-as", [ghAgent, "api", endpoint], { encoding: "utf-8", timeout: 10000 });
  if (r.status !== 0) throw new Error(r.stderr || "gh api failed");
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export function defaultMailSender(to: string, body: string, agentId: string): void {
  spawnSync("tps", ["mail", "send", to, body], {
    encoding: "utf-8",
    env: { ...process.env, TPS_AGENT_ID: agentId },
  });
}

function sendMail(to: string, body: string, config: PulseConfig, sender: MailSender): void {
  console.log(`[pulse] mail → ${to}: ${body.slice(0, 80)}…`);
  sender(to, body, config.ghAgent);
}

// ---------------------------------------------------------------------------
// PR State Computation
// ---------------------------------------------------------------------------

interface GhReview {
  state: string;
  user?: { login?: string };
}

interface GhPr {
  number: number;
  title: string;
  created_at: string;
  state: string;
  merged_at: string | null;
  user?: { login?: string };
  requested_reviewers?: Array<{ login?: string }>;
  head?: { sha?: string };
}

interface GhCommitStatus {
  state?: string;
}

export function computePrState(pr: GhPr, reviews: GhReview[]): PrState {
  if (pr.merged_at || pr.state === "closed") return "merged";

  // Deduplicate reviews: keep last review per user
  const latestByUser = new Map<string, string>();
  for (const r of reviews) {
    const user = r.user?.login ?? "unknown";
    latestByUser.set(user, r.state);
  }

  if (reviews.length === 0) return "opened";

  const states = [...latestByUser.values()];
  if (states.some((s) => s === "CHANGES_REQUESTED")) return "changes-requested";
  if (states.every((s) => s === "APPROVED") && states.length > 0) return "approved";

  return "reviewing";
}

// ---------------------------------------------------------------------------
// Transition Handling
// ---------------------------------------------------------------------------

export function handleTransition(
  key: string,
  instance: PrInstance,
  newState: PrState,
  config: PulseConfig,
  sender: MailSender,
  publisher?: FlairPublisher,
): void {
  const oldState = instance.state;
  if (oldState === newState) return;

  const now = new Date().toISOString();
  instance.history.push({ at: now, from: oldState, to: newState });
  instance.state = newState;
  instance.lastTransitionAt = now;
  instance.reminderSentAt = null;

  console.log(`[pulse] ${key}: ${oldState} → ${newState}`);

  // Publish to Flair (non-blocking, best-effort)
  if (publisher) {
    publisher(key, oldState, newState, instance).catch((e: unknown) => {
      console.warn(`[pulse] Flair publish failed: ${(e as Error).message}`);
    });
  }

  // Determine mail targets based on transition
  switch (newState) {
    case "opened": {
      for (const reviewer of config.reviewers) {
        sendMail(
          reviewer,
          `New PR #${instance.prNumber}: ${instance.title}. Review with: gh-as ${reviewer} pr diff ${instance.prNumber} --repo ${instance.repo}`,
          config,
          sender,
        );
      }
      instance.reviewRequestedAt = now;
      instance.lastRemindedAt = undefined;
      instance.escalatedAt = undefined;
      instance.mergeReadyNotifiedAt = false;
      break;
    }
    case "changes-requested": {
      sendMail(
        config.author,
        `Changes requested on PR #${instance.prNumber} (${instance.repo}): ${instance.title}`,
        config,
        sender,
      );
      break;
    }
    case "reviewing": {
      // Only mail if coming from changes-requested (re-review needed)
      if (oldState === "changes-requested") {
        for (const reviewer of config.reviewers) {
          sendMail(
            reviewer,
            `PR #${instance.prNumber} updated, please re-review: ${instance.title} (${instance.repo})`,
            config,
            sender,
          );
        }
      }
      break;
    }
    case "approved": {
      sendMail(
        config.mergeAuthority,
        `PR #${instance.prNumber} is merge-ready: ${instance.title} (${instance.repo})`,
        config,
        sender,
      );
      break;
    }
    case "merged": {
      sendMail(
        config.author,
        `PR #${instance.prNumber} merged: ${instance.title} (${instance.repo})`,
        config,
        sender,
      );
      for (const reviewer of config.reviewers) {
        const removed = gcMessages(reviewer, "24h", instance.prNumber);
        if (removed > 0) {
          console.log(`[pulse] gc → ${reviewer}: removed ${removed} mail item(s) for PR #${instance.prNumber}`);
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Timer / Reminder Checks
// ---------------------------------------------------------------------------

export function checkReminders(
  state: PulseState,
  config: PulseConfig,
  sender: MailSender,
  pendingReviews: Record<string, string[]>,
  now: Date = new Date(),
): void {
  for (const [key, instance] of Object.entries(state.instances)) {
    if (instance.state === "merged") continue;
    const pending = pendingReviews[key] ?? [];
    if (pending.length === 0) continue;
    const requestedAt = instance.reviewRequestedAt ? Date.parse(instance.reviewRequestedAt) : NaN;
    if (Number.isNaN(requestedAt)) continue;
    const elapsed = now.getTime() - requestedAt;

    if (elapsed >= config.remindAfterMs) {
      const lastRemindedAt = instance.lastRemindedAt ? Date.parse(instance.lastRemindedAt) : 0;
      if (!instance.lastRemindedAt || (now.getTime() - lastRemindedAt) >= config.remindAfterMs) {
        for (const reviewer of pending) {
          sendMail(
            reviewer,
            `Reminder: PR #${instance.prNumber} still needs your review. Repo: ${instance.repo}. gh-as ${reviewer} pr diff ${instance.prNumber} --repo ${instance.repo}`,
            config,
            sender,
          );
        }
        instance.lastRemindedAt = now.toISOString();
        console.log(`[pulse] ${key}: sent review reminder`);
      }
    }

    if (elapsed >= (2 * config.remindAfterMs) && !instance.escalatedAt) {
      sendMail(
        config.mergeAuthority,
        `ESCALATE: PR #${instance.prNumber} has no review after 60 min. Repo: ${instance.repo}. Missing: ${pending.join(", ")}`,
        config,
        sender,
      );
      instance.escalatedAt = now.toISOString();
      console.log(`[pulse] ${key}: escalated missing review`);
    }
  }
}

// ---------------------------------------------------------------------------
// Single Poll Cycle
// ---------------------------------------------------------------------------

export function pollOnce(
  config: PulseConfig,
  state: PulseState,
  runner: SyncRunner = spawnSync as unknown as SyncRunner,
  sender: MailSender = defaultMailSender,
  publisher?: FlairPublisher,
): void {
  const pollStartedAt = new Date().toISOString();
  const now = new Date().toISOString();
  const pendingReviews: Record<string, string[]> = {};

  for (const repo of config.repos) {
    let prs: GhPr[];
    try {
      prs = ghApi(`repos/${repo}/pulls?state=open&sort=updated`, config.ghAgent, runner) as GhPr[];
    } catch (e: unknown) {
      console.warn(`[pulse] Failed to fetch PRs for ${repo}: ${(e as Error).message}`);
      continue;
    }

    // Also check recently merged/closed PRs we're tracking
    const trackedInRepo = Object.entries(state.instances).filter(
      ([, inst]) => inst.repo === repo && inst.state !== "merged",
    );

    for (const pr of prs) {
      const key = `pr:${repo}#${pr.number}`;
      let reviews: GhReview[];
      try {
        reviews = ghApi(`repos/${repo}/pulls/${pr.number}/reviews`, config.ghAgent, runner) as GhReview[];
      } catch (e: unknown) {
        console.warn(`[pulse] Failed to fetch reviews for ${key}: ${(e as Error).message}`);
        continue;
      }

      const computed = computePrState(pr, reviews);
      const latestByUser = new Map<string, string>();
      for (const r of reviews) latestByUser.set(r.user?.login ?? "unknown", r.state);
      const configuredReviewers = config.reviewers;
      const missingReviews = configuredReviewers.filter((reviewer) => {
        const ghUser = reviewer.startsWith("tps-") ? reviewer : `tps-${reviewer}`;
        return !latestByUser.has(ghUser);
      });
      pendingReviews[key] = missingReviews;
      let ciGreen = false;
      if (pr.head?.sha) {
        try {
          const status = ghApi(`repos/${repo}/commits/${pr.head.sha}/status`, config.ghAgent, runner) as GhCommitStatus;
          ciGreen = status.state === "success";
        } catch {
          ciGreen = false;
        }
      }
      const existing = state.instances[key];

      if (!existing) {
        // New PR — create instance and handle transition from null
        const instance: PrInstance = {
          state: "opened" as PrState,
          prNumber: pr.number,
          repo,
          title: pr.title,
          author: pr.user?.login ?? "unknown",
          reviewers: (pr.requested_reviewers ?? []).map((r) => r.login ?? "unknown"),
          lastTransitionAt: now,
          reminderSentAt: null,
          reviewRequestedAt: now,
          lastRemindedAt: undefined,
          escalatedAt: undefined,
          mergeReadyNotifiedAt: false,
          history: [{ at: now, from: null, to: "opened" }],
        };
        state.instances[key] = instance;
        console.log(`[pulse] ${key}: new PR tracked (${computed})`);

        // Skip notifications for PRs that existed before this pulse session started
        const isPreExisting =
          state.lastPollAt && new Date(pr.created_at) < new Date(state.lastPollAt);
        if (isPreExisting) {
          console.log(`[pulse] ${key}: pre-existing PR, skipping notification`);
          // Still advance state if needed
          if (computed !== "opened") {
            handleTransition(key, instance, computed, config, sender, publisher);
          }
          continue;
        }

        // Notify reviewers for new PR
        for (const reviewer of config.reviewers) {
          sendMail(
            reviewer,
            `New PR #${pr.number}: ${pr.title}. Review with: gh-as ${reviewer} pr diff ${pr.number} --repo ${repo}`,
            config,
            sender,
          );
        }

        // If PR already has reviews, advance state
        if (computed !== "opened") {
          handleTransition(key, instance, computed, config, sender, publisher);
        }
      } else {
        // Existing PR — check for state change
        existing.title = pr.title;
        handleTransition(key, existing, computed, config, sender, publisher);
      }

      const instance = state.instances[key];
      if (instance.state === "opened" && !instance.reviewRequestedAt) {
        instance.reviewRequestedAt = instance.lastTransitionAt;
      }
      if (instance.state === "approved" && ciGreen && !instance.mergeReadyNotifiedAt) {
        sendMail(
          config.mergeAuthority,
          `MERGE READY: PR #${instance.prNumber} — all reviews in, CI green. Repo: ${instance.repo}`,
          config,
          sender,
        );
        instance.mergeReadyNotifiedAt = true;
        console.log(`[pulse] ${key}: merge ready notified`);
      }
    }

    // Check tracked PRs that might have been merged/closed (not in open list)
    const openNumbers = new Set(prs.map((p) => p.number));
    for (const [key, inst] of trackedInRepo) {
      if (openNumbers.has(inst.prNumber)) continue;
      // PR is no longer open — check if merged
      try {
        const prData = ghApi(`repos/${repo}/pulls/${inst.prNumber}`, config.ghAgent, runner) as GhPr;
        if (prData.merged_at) {
          handleTransition(key, inst, "merged", config, sender, publisher);
        }
      } catch (e: unknown) {
        console.warn(`[pulse] Failed to check closed PR ${key}: ${(e as Error).message}`);
      }
    }
  }

  // Check timers
  checkReminders(state, config, sender, pendingReviews);

  state.lastPollAt = pollStartedAt;
}

// ---------------------------------------------------------------------------
// Poll Loop (foreground)
// ---------------------------------------------------------------------------

export function makeFlairPublisher(config: PulseConfig): FlairPublisher | undefined {
  if (!config.flairUrl || !config.flairAgentId || !config.flairAgentKey) return undefined;
  try {
    const client = createFlairClient(config.flairAgentId, config.flairUrl, config.flairAgentKey);
    return async (key: string, from: PrState | null, to: PrState, instance: PrInstance) => {
      // Publish OrgEvent for state transition
      await client.publishEvent({
        kind: `pr.${to}`,
        scope: key,
        summary: `PR #${instance.prNumber} (${instance.repo}): ${from ?? "new"} → ${to}`,
        detail: instance.title,
        refId: key,
      });
      // Store as persistent memory (stable id per PR key — same PUT overwrites)
      const memId = `${config.flairAgentId}-pulse-${key.replace(/[^a-z0-9]/gi, "-")}`;
      const content = `PR ${key} state: ${to}. Title: "${instance.title}". Transition: ${from ?? "new"} → ${to} at ${instance.lastTransitionAt}.`;
      await client.writeMemory(memId, content, {
        durability: "persistent",
        type: "fact",
        tags: ["pulse", "pr-lifecycle", to],
      });
    };
  } catch (e: unknown) {
    console.warn(`[pulse] Failed to create Flair publisher: ${(e as Error).message}`);
    return undefined;
  }
}

export async function startPollLoop(
  config: PulseConfig,
  state: PulseState,
  opts: {
    dryRun?: boolean;
    runner?: SyncRunner;
    sender?: MailSender;
    publisher?: FlairPublisher;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): Promise<void> {
  const runner = opts.runner ?? (spawnSync as unknown as SyncRunner);
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const sender = opts.dryRun
    ? (to: string, body: string, _agentId: string) => {
        console.log(`[pulse/dry-run] would mail ${to}: ${body.slice(0, 80)}…`);
      }
    : (opts.sender ?? defaultMailSender);
  const publisher = opts.dryRun ? undefined : (opts.publisher ?? makeFlairPublisher(config));

  console.log(`[pulse] Starting poll loop (interval=${config.pollIntervalMs}ms, repos=${config.repos.join(", ")})`);

  const poll = () => {
    try {
      // Prune stale terminal instances before each poll
      const pruned = pruneState(state, config.pruneAfterDays);
      if (pruned > 0) console.log(`[pulse] Pruned ${pruned} completed instance(s) older than ${config.pruneAfterDays} days`);
      pollOnce(config, state, runner, sender, publisher);
      saveState(state);
    } catch (e: unknown) {
      console.error(`[pulse] Poll error: ${(e as Error).message}`);
    }
  };

  // First poll immediately
  poll();

  // Then on interval
  const handle = setIntervalFn(poll, config.pollIntervalMs);
  const keepalive = setIntervalFn(() => {}, 1 << 30);

  // Graceful shutdown
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearIntervalFn(handle);
      clearIntervalFn(keepalive);
      saveState(state);
      console.log("[pulse] Stopped.");
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export function printStatus(args: Pick<PulseArgs, "json"> = {}, state = loadState()): void {
  if (!state.lastPollAt) {
    console.log("Pulse has not run yet.");
    return;
  }
  const active = Object.values(state.instances).filter((i) => i.state !== "merged");
  if (args.json) {
    console.log(
      JSON.stringify({
        lastPollAt: state.lastPollAt,
        activeCount: active.length,
        active,
      }),
    );
    return;
  }
  console.log(`Last poll: ${state.lastPollAt}`);
  console.log(`Active PRs: ${active.length}`);
  for (const inst of active) {
    console.log(`  PR #${inst.prNumber} (${inst.repo}): ${inst.state} since ${inst.lastTransitionAt}`);
  }
}

function printList(): void {
  const state = loadState();
  const entries = Object.entries(state.instances);
  if (entries.length === 0) {
    console.log("No tracked PR instances.");
    return;
  }
  for (const [key, inst] of entries) {
    const transitions = inst.history.length;
    console.log(`  ${key}: ${inst.state} (${transitions} transitions) — ${inst.title}`);
  }
}

// ---------------------------------------------------------------------------
// Command Entry Point
// ---------------------------------------------------------------------------

export interface PulseArgs {
  action: string;
  repo?: string;
  interval?: number;
  dryRun?: boolean;
  json?: boolean;
}

export async function runPulse(args: PulseArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      const config = loadConfig();
      if (args.repo) {
        config.repos = [args.repo];
      }
      if (args.interval) {
        config.pollIntervalMs = args.interval * 1000;
      }
      const state = loadState();
      await startPollLoop(config, state, { dryRun: args.dryRun });
      break;
    }
    case "status": {
      printStatus({ json: args.json });
      break;
    }
    case "list": {
      printList();
      break;
    }
    default: {
      console.error("Usage:\n  tps pulse start [--repo <repo>] [--interval <seconds>] [--dry-run]\n  tps pulse status\n  tps pulse list");
      process.exit(1);
    }
  }
}
