/**
 * codex-runtime.ts — Agent runtime backed by the Codex CLI (codex exec --json).
 * Uses ChatGPT OAuth credentials; no OpenAI API key required.
 * Same interface as claude-code-runtime.ts.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  refreshOpenAIToken,
  type StoredCredentials,
} from "../commands/auth.js";
import { agentKeyCandidates, resolveAgentKeyPath } from "./agent-keys.js";
import {
  bootContext,
  catchUpTopics,
  onBoot,
  onTaskComplete,
  onTaskFailure,
  onTaskStart,
  getFallbackSoulPath,
  searchPastExperience,
  snapshotSoulToDisk,
  writeTaskMemory,
} from "./agent-lifecycle.js";
import { FlairClient, type PresenceActivity } from "./flair-client.js";
import { startTaskLoop } from "./flair-task-loop.js";
import { homeDir } from "./home.js";
import { startReviewTriggerLoop } from "./pr-review-trigger.js";
import { providerAuthPath } from "./runtime-credentials.js";
import { completeRuntimeMail, pollRuntimeMail, type RuntimeMailConfig, runtimeBootPreflight, sendRuntimeMail } from "./runtime-mail.js";
import { externalDispatchRefusal } from "./mail-tier.js";
import type { Envelope } from "@tpsdev-ai/agent";
import { formatTaskCompleteMailBody } from "./task-result-mail.js";
import type { WorkspaceProvider, WorkspaceState } from "./workspace-provider.js";

/** Real git binary path — bypasses codex-tools wrapper that blocks commit/push */
const GIT_BIN = process.env.TPS_GIT_BIN ?? "/usr/bin/git";

function shouldSendTaskCompletion(recipient: string, reviewNotify?: string[]): boolean {
  return !(reviewNotify?.includes(recipient));
}

/** Read OpenAI OAuth creds from ~/.tps/auth/openai.json (written by tps auth login openai). */
function readStoredOpenAICreds(): StoredCredentials | null {
  const credPath = providerAuthPath("openai");
  if (!existsSync(credPath)) return null;
  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (!data.accessToken || !data.refreshToken) return null;
    return data as StoredCredentials;
  } catch {
    return null;
  }
}

/** Refresh OpenAI OAuth token if expiring within 1 hour. No-op if not stored or already fresh. */
async function ensureFreshOpenAIToken(agentId: string): Promise<void> {
  const creds = readStoredOpenAICreds();
  if (!creds) return;

  const oneHourMs = 60 * 60 * 1000;
  const isExpiringSoon = creds.expiresAt > 0 && creds.expiresAt - Date.now() < oneHourMs;
  if (!isExpiringSoon) return;

  if (!creds.clientId) {
    console.warn(`[${agentId}] ⚠️  OpenAI token expiring soon but no clientId — re-run: tps auth login openai`);
    return;
  }

  try {
    const refreshed = await refreshOpenAIToken(creds);
    console.log(`[${agentId}] OpenAI token refreshed — expires ${new Date(refreshed.expiresAt).toISOString()}`);
  } catch (err: any) {
    console.warn(`[${agentId}] ⚠️  OpenAI token refresh failed (non-fatal): ${err.message}`);
  }
}

const FLAIR_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AutoCommitConfig {
  /**
   * Repository path to commit changes in (defaults to workspace). A relative
   * path is resolved against the config file's directory when the agent config
   * is loaded; the runtime requires an absolute path.
   */
  repo?: string;
  /** Branch name prefix; task refId appended: e.g. "task/" -> "task/ops-68" */
  branchPrefix?: string;
  /** Commit author name (defaults to agentId) */
  authorName?: string;
  /** Commit author email (defaults to agentId@tps.dev) */
  authorEmail?: string;
  /** Push branch to origin and open PR after commit */
  push?: boolean;
  /** Open a PR after pushing the branch */
  openPr?: boolean;
  /** Repo slug to target when opening a PR, e.g. "org/repo" */
  prRepo?: string;
  /** PR title to use when opening a PR */
  prTitle?: string;
  /** Path to the GitHub PAT file; basename maps to gh-as agent handle */
  githubPat?: string;
  /** Agent IDs to notify via tps mail after PR opens (e.g. ["sherlock"]) */
  reviewNotify?: string[];
}

export interface CodexRuntimeConfig {
  agentId: string;
  workspace: string;
  mailDir: string;
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  extraDirs?: string[];
  supervisorId?: string;
  taskTimeoutMs?: number;
  watchdogTimeoutMs?: number;
  sessionLogPath?: string;
  flairUrl?: string;
  flairKeyPath?: string;
  systemPrompt?: string;
  workspaceProvider?: WorkspaceProvider;
  /** If set, auto-commit workspace changes after each task completes */
  autoCommit?: AutoCommitConfig;
  /** If set, listen for pr.opened events and auto-request reviews */
  reviewTrigger?: { reviewers: string[]; repo: string };
}

/**
 * The repository auto-commit writes to. Config load resolves a relative
 * `autoCommit.repo` against the config file's directory; a relative value that
 * reaches the runtime is refused rather than resolved against the process
 * working directory.
 */
export function resolveCommitRepo(config: { workspace: string; autoCommit?: AutoCommitConfig }): string {
  const configured = config.autoCommit?.repo;
  const repo = configured ?? config.workspace;
  if (!isAbsolute(repo)) {
    throw new Error(
      `${configured === undefined ? "workspace" : "autoCommit.repo"} '${repo}' is relative: use an absolute path`,
    );
  }
  return resolve(repo);
}

interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

/**
 * cli#433 (slice B2-1): the consumer-side tier gate for the Codex runtime. A
 * verified record whose SIGNED tier is external is not dispatched with the
 * internal capability set; returns the named reason, or null to dispatch.
 */
export function codexDispatchRefusal(envelope: Envelope | undefined, from: string, tier?: string): string | null {
  return externalDispatchRefusal(envelope, from, tier);
}

export function composeSystemPrompt(
  flairSystemPrompt: string,
  configSystemPrompt?: string,
  experience?: string,
): string {
  let systemPrompt = flairSystemPrompt;
  if (configSystemPrompt) {
    systemPrompt += "\n\n" + configSystemPrompt;
  }
  if (experience) {
    systemPrompt += "\n\n" + experience;
  }
  return systemPrompt;
}

async function buildSystemPrompt(
  message: MailMessage,
  config: CodexRuntimeConfig,
): Promise<string> {
  const { agentId, workspace, extraDirs, supervisorId, flairUrl, flairKeyPath } = config;
  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: resolveRuntimeKeyPath(agentId, flairKeyPath) });
  const allowedTools = ["Bash", "Read", "Write", "Edit"];
  const { systemPrompt } = await bootContext(
    flair, agentId, message.body.slice(0, 100), workspace,
    { allowedTools, supervisorId },
  );
  const experience = await searchPastExperience(flair, message.body, workspace);
  return composeSystemPrompt(systemPrompt, config.systemPrompt, experience);
}

interface RunCodexOptions {
  flairPublisher?: { publishEvent: (ev: Record<string, unknown>) => Promise<void> };
  onStall?: () => void;
}

export function codexExecArgs(config: CodexRuntimeConfig): string[] {
  const args = [
    "exec", "--json", "--ephemeral",
    ...(config.model ? ["--model", config.model] : []),
    "--sandbox", config.sandboxMode ?? "workspace-write",
    "--cd", config.workspace,
    "-",
  ];
  for (const dir of config.extraDirs ?? []) args.push("--add-dir", dir);
  return args;
}

async function runCodex(
  message: MailMessage,
  config: CodexRuntimeConfig,
  taskTimeoutMs: number,
  opts: RunCodexOptions = {},
): Promise<string> {
  await syncWorkspaceBeforeTask(config);
  const systemPrompt = await buildSystemPrompt(message, config);

  const prompt = [systemPrompt, "", `[Mail from: ${message.from}]`, message.body].join("\n");

  const args = codexExecArgs(config);

  const logPath = config.sessionLogPath ?? join(homeDir(), ".tps", "agents", config.agentId, "session.log");
  appendFileSync(logPath, `\n${"=".repeat(60)}\n[${new Date().toISOString()}] Task from ${message.from} (codex)\n${"=".repeat(60)}\n`, "utf-8");
  const logStream = createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve, reject) => {
    const codexToolsDir = join(homeDir(), ".tps", "bin", "codex-tools");
    const codexEnv = { ...process.env, PATH: `${codexToolsDir}:${process.env.PATH ?? ""}` };
    const proc = spawn("codex", args, { cwd: config.workspace, env: codexEnv });
    proc.stdin.write(prompt);
    proc.stdin.end();

    const resultMessages: string[] = [];
    let turnCount = 0;
    let stderr = "";
    let buf = "";

    // Watchdog: kill + stall event if no JSONL output for watchdogTimeoutMs
    const watchdogMs = config.watchdogTimeoutMs ?? 5 * 60 * 1000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.warn(`[${config.agentId}] Watchdog: no output for ${watchdogMs / 1000}s — killing Codex`);
        proc.kill("SIGTERM");
        // Publish task.stalled OrgEvent (non-fatal)
        opts.onStall?.();
        if (opts.flairPublisher) {
          opts.flairPublisher.publishEvent({
            kind: "task.stalled",
            authorId: config.agentId,
            summary: `Task stalled (no output for ${Math.round(watchdogMs / 60000)}m)`,
            refId: message.id,
          }).catch(() => {});
        }
      }, watchdogMs);
    };
    resetWatchdog();

    proc.stdout.on("data", (d: Buffer) => {
      logStream.write(d);
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        resetWatchdog(); // reset on each JSONL line
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const item = event.item as Record<string, unknown> | undefined;
          if (event.type === "item.completed" && item) {
            if (item.type === "agent_message" && typeof item.text === "string") {
              resultMessages.push(item.text);
            } else if (item.type === "command_execution") {
              turnCount++;
              console.log(`[${config.agentId}] turn ${turnCount}: exec(${String(item.command ?? "").slice(0, 80)}) → ${item.exit_code}`);
            }
          } else if (event.type === "turn.completed") {
            const u = event.usage as Record<string, number> | undefined;
            if (u) console.log(`[${config.agentId}] tokens: in=${u.input_tokens} out=${u.output_tokens}`);
          }
        } catch {}
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      logStream.write(d);
      resetWatchdog(); // stderr output also counts as activity
    });

    const timeout = setTimeout(() => proc.kill("SIGTERM"), taskTimeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (watchdog) clearTimeout(watchdog);
      logStream.end();
      const resultText = resultMessages.join("\n\n").trim();
      if (resultText) {
        resolve(resultText);
      } else if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        reject(new Error("codex exited 0 with no agent_message output"));
      }
    });
    proc.on("error", reject);
  });
}

/** Run tps agent commit for the given config + task. Non-fatal — logs on failure. */
export interface AutoCommitOptions {
  taskId: string;
  branchName: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  push?: boolean;
  openPr?: boolean;
  prRepo?: string;
  ghAgent?: string;
  prTitle?: string;
  prBody?: string;
  reviewNotify?: string[];
  /**
   * Runtime mail identity used to SIGN reviewer notifications (cli#380 defect 8).
   * `sendMessage()` alone ships an unsigned body, which a promote()-reading
   * recipient dead-letters; reviewer notifications go through the signed path.
   */
  signCfg?: RuntimeMailConfig;
}

export interface AutoCommitDeps {
  spawnSyncImpl?: typeof spawnSync;
  tpsCommand?: string;
}

export interface WorkspaceSyncDeps {
  spawnSyncImpl?: typeof spawnSync;
  warn?: (message?: any, ...optionalParams: any[]) => void;
}

export function hasWorkspaceChangesOrNewCommit(statusOutput: string, baseline?: string | null, currentHead?: string | null): boolean {
  return statusOutput.trim().length > 0 || currentHead !== baseline;
}

export interface StaleRebaseDetection {
  state: "present" | "absent" | "indeterminate";
  /** The failed probe, when state is "indeterminate". */
  probe?: string;
  /** The probe's unusable output, when state is "indeterminate". */
  output?: string;
}

/**
 * Detect an interrupted rebase (merge or apply backend) in `repo` using git's
 * own paths for the repository at that location, including a linked worktree
 * whose `.git` is a file. A probe whose output is not an absolute path cannot
 * name the repository's Git directory (git before 2.31 echoes the
 * `--path-format=absolute` flag instead), so the detection is indeterminate.
 */
export function detectStaleRebase(
  repo: string,
  runSync: typeof spawnSync = spawnSync,
): StaleRebaseDetection {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const probe = `git rev-parse --path-format=absolute --git-path ${dir}`;
    const result = runSync(GIT_BIN, ["rev-parse", "--path-format=absolute", "--git-path", dir], {
      cwd: repo,
      encoding: "utf-8",
    });
    if (result.status !== 0) return { state: "indeterminate", probe };
    const path = String(result.stdout ?? "").trim();
    if (!path || !isAbsolute(path)) return { state: "indeterminate", probe, output: path };
    if (existsSync(path)) return { state: "present" };
  }
  return { state: "absent" };
}

export type HeadProbe =
  | { state: "commit"; head: string }
  | { state: "unborn" }
  | { state: "indeterminate"; detail: "failed" | "returned no output" };

/**
 * Classify the repository's HEAD. A commit is a successful `git rev-parse HEAD`
 * with output. An unborn HEAD is a symbolic HEAD naming a branch whose
 * `git rev-parse --verify -q HEAD` finds no commit (exit 1, no output). Any
 * other outcome is indeterminate.
 */
export function probeHead(repo: string, runSync: typeof spawnSync = spawnSync): HeadProbe {
  const head = runSync(GIT_BIN, ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" });
  const headText = String(head.stdout ?? "").trim();
  if (head.status === 0) {
    return headText ? { state: "commit", head: headText } : { state: "indeterminate", detail: "returned no output" };
  }
  const symbolic = runSync(GIT_BIN, ["symbolic-ref", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
  const branch = String(symbolic.stdout ?? "").trim();
  if (symbolic.status === 0 && branch) {
    const verify = runSync(GIT_BIN, ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
    if (verify.status === 1 && String(verify.stdout ?? "").trim() === "") return { state: "unborn" };
  }
  return { state: "indeterminate", detail: "failed" };
}

export type MailAutoCommitDecision =
  | { action: "commit" }
  | { action: "clean"; message: string }
  | { action: "skip"; message: string };

/**
 * Decide whether a mail task left changes worth committing in `repo`.
 *
 * Every probe runs against the one repository the caller resolved for the
 * commit, and an interrupted rebase is detected and aborted there too. For a
 * commit baseline the comparison is always the HEAD read before the task: a
 * successful abort restores the pre-rebase checkout/HEAD (a rebase can start
 * from a detached HEAD), so a restored HEAD different from the pre-task HEAD
 * causes a commit attempt. That can be a commit made on that branch before the
 * rebase, not necessarily this task's.
 * A failed probe is indeterminate and yields a skip with its outcome reported,
 * and so does a final HEAD that differs from the restored one. An unborn HEAD
 * (a repository with no commits) has no pre-task value to compare, so workspace
 * changes or a new commit select the commit path, and neither is clean. For a
 * commit baseline, the clean decision establishes exactly this: Git status is
 * clean and the final HEAD matches its pre-task value — `git status --porcelain`
 * omits ignored files, and equal HEADs do not rule out a commit that was later
 * reset.
 */
export function evaluateMailAutoCommitGate(
  repo: string,
  baseline: string | HeadProbe | undefined,
  deps: { runSync?: typeof spawnSync } = {},
): MailAutoCommitDecision {
  const runSync = deps.runSync ?? spawnSync;
  const baselineProbe: HeadProbe =
    typeof baseline === "string"
      ? { state: "commit", head: baseline }
      : (baseline ?? { state: "indeterminate", detail: "failed" });
  const staleRebase = detectStaleRebase(repo, runSync);
  if (staleRebase.state === "indeterminate") {
    const detail = staleRebase.output !== undefined ? ` returned '${staleRebase.output}'` : " failed";
    return { action: "skip", message: `Stale rebase check could not run: ${staleRebase.probe}${detail} — skipping autoCommit` };
  }
  if (baselineProbe.state === "indeterminate") {
    return { action: "skip", message: "Change check could not run: git rev-parse HEAD (before task) failed — skipping autoCommit" };
  }

  let restoredHead: string | undefined;
  if (staleRebase.state === "present") {
    const abortResult = runSync(GIT_BIN, ["rebase", "--abort"], { cwd: repo, encoding: "utf-8" });
    if (abortResult.status !== 0) {
      const firstLine = String(abortResult.stderr ?? "").trim().split("\n")[0] ?? "";
      return { action: "skip", message: `Stale rebase abort failed (exit ${abortResult.status}): ${firstLine} — skipping autoCommit` };
    }
    const restored = probeHead(repo, runSync);
    if (restored.state !== "commit") {
      return { action: "skip", message: "Change check could not run: git rev-parse HEAD (after rebase abort) failed — skipping autoCommit" };
    }
    restoredHead = restored.head;
  }

  const statusResult = runSync(GIT_BIN, ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
  if (statusResult.status !== 0) {
    return { action: "skip", message: "Change check could not run: git status --porcelain failed — skipping autoCommit" };
  }
  const finalProbe = probeHead(repo, runSync);
  if (finalProbe.state === "indeterminate") {
    const detail = finalProbe.detail === "returned no output" ? "returned no output" : "failed";
    return { action: "skip", message: `Change check could not run: git rev-parse HEAD (after task) ${detail} — skipping autoCommit` };
  }
  if (finalProbe.state === "unborn") {
    if (baselineProbe.state === "commit") {
      return { action: "skip", message: "Change check could not run: git rev-parse HEAD (after task) failed — skipping autoCommit" };
    }
    const changed = String(statusResult.stdout ?? "").trim().length > 0;
    if (changed) return { action: "commit" };
    return { action: "clean", message: "Git status is clean and the repository has no commits — skipping autoCommit" };
  }
  const finalHead = finalProbe.head;
  if (restoredHead !== undefined && finalHead !== restoredHead) {
    return {
      action: "skip",
      message: `Change check could not run: HEAD changed between the restored read and the final read (restored ${restoredHead}, final ${finalHead}) — skipping autoCommit`,
    };
  }
  if (baselineProbe.state === "unborn") {
    return { action: "commit" };
  }

  const changed = hasWorkspaceChangesOrNewCommit(
    String(statusResult.stdout ?? ""),
    baselineProbe.head,
    finalHead,
  );
  if (changed) return { action: "commit" };
  return { action: "clean", message: "Git status is clean and HEAD matches its pre-task value — skipping autoCommit" };
}

interface AutoCommitFlair {
  publishEvent(event: { kind: string; summary: string; detail?: string; refId?: string }): Promise<void>;
}

interface OrgEventClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export async function publishTaskOutcomeEvent(
  flair: OrgEventClient,
  agentId: string,
  event: { kind: "task.completed" | "task.failed"; summary: string; refId: string },
): Promise<void> {
  try {
    await flair.request("POST", "/OrgEvent", { ...event, authorId: agentId });
  } catch {
    /* non-fatal */
  }
}

function resolveDefaultBranch(repo: string, runSync: typeof spawnSync): string {
  const headRef = runSync(GIT_BIN, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repo,
    encoding: "utf-8",
  });
  if ((headRef.status ?? 1) === 0) {
    const ref = typeof headRef.stdout === "string" ? headRef.stdout.trim() : "";
    const branch = ref.replace(/^origin\//, "");
    if (branch) return branch;
  }
  return "main";
}

export async function syncWorkspaceBeforeTask(
  config: CodexRuntimeConfig,
  deps: WorkspaceSyncDeps = {},
): Promise<void> {
  const runSync = deps.spawnSyncImpl ?? spawnSync;
  const warn = deps.warn ?? console.warn;
  const branch = resolveDefaultBranch(config.workspace, runSync);

  // Abort any in-progress rebase or merge before touching the worktree.
  const rebaseMergeCheck = runSync(GIT_BIN, ["rebase", "--abort"], { cwd: config.workspace, encoding: "utf-8" });
  if ((rebaseMergeCheck.status ?? 1) === 0) {
    warn(`[${config.agentId}] Aborted stale in-progress rebase before sync.`);
  }

  // Checkout default branch — task branches or detached HEAD both need this.
  const checkoutResult = runSync(GIT_BIN, ["checkout", branch], { cwd: config.workspace, encoding: "utf-8" });
  if ((checkoutResult.status ?? 1) !== 0) {
    const stderr = typeof checkoutResult.stderr === "string" ? checkoutResult.stderr.trim() : "";
    warn(`[${config.agentId}] git checkout ${branch} failed (non-fatal): ${stderr}`);
  }

  // Fetch latest from origin.
  runSync(GIT_BIN, ["fetch", "origin", branch], { cwd: config.workspace, encoding: "utf-8" });

  // Hard reset to origin/<branch> — eliminates stale commits, conflict markers, and
  // carried-over task-branch changes that survive rebases on dirty worktrees.
  const resetResult = runSync(GIT_BIN, ["reset", "--hard", `origin/${branch}`], {
    cwd: config.workspace,
    encoding: "utf-8",
  });
  if ((resetResult.status ?? 1) !== 0) {
    const stderr = typeof resetResult.stderr === "string" ? resetResult.stderr.trim() : "";
    warn(`[${config.agentId}] Workspace sync: git reset --hard failed (non-fatal): ${stderr}`);
    return;
  }

  // Remove untracked files and directories left by prior task branches.
  runSync(GIT_BIN, ["clean", "-fd"], { cwd: config.workspace, encoding: "utf-8" });

  console.log(`[${config.agentId}] Workspace synced to origin/${branch}.`);
}

function openPullRequest(
  runSync: typeof spawnSync,
  flair: AutoCommitFlair,
  options: AutoCommitOptions,
  authorEmail: string,
  repo: string,
): Promise<string | undefined> {
  const {
    taskId,
    branchName,
    commitMessage,
    prRepo,
    ghAgent,
    prTitle,
    prBody,
  } = options;

  return (async () => {
    if (!options.push || !options.openPr || !prRepo) return undefined;
    const prArgs = [
      ghAgent ?? authorEmail.split("@")[0] ?? "",
      "pr",
      "create",
      "--repo",
      prRepo,
      "--head",
      branchName,
      "--title", prTitle ?? `task: ${taskId}`,
      "--body",
      prBody ?? commitMessage,
    ];
    console.log(`[autoCommit] opening PR: gh-as ${prArgs[0]} pr create --repo ${prRepo} --head ${branchName}`);
    const prResult = runSync("gh-as", prArgs, { cwd: repo, encoding: "utf-8" });
    const prStdout2 = typeof prResult.stdout === "string" ? prResult.stdout.trim() : "";
    const prStderr2 = typeof prResult.stderr === "string" ? prResult.stderr.trim() : "";
    console.log(`[autoCommit] gh-as pr create exit=${prResult.status} stdout=${prStdout2.slice(0, 200)}`);
    if (prStderr2) console.log(`[autoCommit] gh-as stderr: ${prStderr2.slice(0, 200)}`);
    if ((prResult.status ?? 1) === 0) {
      const prUrl = prStdout2.trim();
      const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? "?";
      if (options.reviewNotify?.length && options.signCfg) {
        for (const reviewer of options.reviewNotify) {
          try {
            const { sendRuntimeMail } = await import("./runtime-mail.js");
            sendRuntimeMail(options.signCfg, reviewer, `PR #${prNumber} for review: ${prUrl}`);
            console.log(`[autoCommit] Notified reviewer: ${reviewer} (PR #${prNumber})`);
          } catch (notifyErr: any) {
            console.warn(`[autoCommit] Failed to notify ${reviewer}: ${notifyErr.message}`);
          }
        }
      }
      return prUrl;
    }

    const prErrMsg = prStderr2 || prStdout2 || `exit ${prResult.status ?? "unknown"}`;
    try {
      await flair.publishEvent({
        kind: "blocker",
        summary: `PR creation failed for ${taskId}`,
        detail: prErrMsg,
        refId: taskId,
      });
    } catch { /* non-fatal */ }
    throw new Error(`gh-as pr create failed: ${prErrMsg}`);
  })();
}

export async function runAutoCommit(
  config: Pick<CodexRuntimeConfig, "workspace">,
  flair: AutoCommitFlair,
  options: AutoCommitOptions,
  deps: AutoCommitDeps = {},
): Promise<string | undefined> {
  const runSync = deps.spawnSyncImpl ?? spawnSync;
  const tpsCmd = deps.tpsCommand ?? "tps";
  const repo = config.workspace;
  const {
    taskId,
    branchName,
    commitMessage,
    authorName,
    authorEmail,
    push,
    openPr,
    prRepo,
    ghAgent,
    prTitle,
    prBody,
  } = options;

  // Ensure we're on a named branch (not detached HEAD) before committing
  const headCheck = runSync(GIT_BIN, ["symbolic-ref", "--quiet", "HEAD"], { cwd: repo, encoding: "utf-8" });
  if ((headCheck.status ?? 1) !== 0) {
    const checkout = runSync(GIT_BIN, ["checkout", "-b", branchName], { cwd: repo, encoding: "utf-8" });
    if ((checkout.status ?? 1) !== 0) {
      const stderr = typeof checkout.stderr === "string" ? checkout.stderr.trim() : "";
      throw new Error(`create branch ${branchName} failed: ${stderr || `exit ${checkout.status}`}`);
    }
  }

  const statusResult = runSync(GIT_BIN, ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
  const hasWorkingTreeChanges = ((statusResult.stdout ?? "") as string).trim().length > 0;
  const remoteRefCheck = runSync(GIT_BIN, ["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], { cwd: repo, encoding: "utf-8" });
  const aheadResult = runSync(
    GIT_BIN,
    ["rev-list", "--count", remoteRefCheck.status === 0 ? `origin/${branchName}..HEAD` : "HEAD"],
    { cwd: repo, encoding: "utf-8" },
  );
  const aheadCount = parseInt(((aheadResult.stdout ?? "") as string).trim(), 10);
  const hasExistingCommits = !Number.isNaN(aheadCount) && aheadCount > 0;

  if (!hasWorkingTreeChanges && hasExistingCommits) {
    console.log(`[autoCommit] reusing existing commits on ${branchName}`);
    if (push) {
      const checkoutResult = runSync(GIT_BIN, ["checkout", "-b", branchName], { cwd: repo, encoding: "utf-8" });
      if ((checkoutResult.status ?? 1) !== 0) {
        runSync(GIT_BIN, ["checkout", branchName], { cwd: repo, encoding: "utf-8" });
      }
      const pushResult = runSync(GIT_BIN, ["push", "-u", "origin", branchName], { cwd: repo, encoding: "utf-8" });
      const pushStdout = typeof pushResult.stdout === "string" ? pushResult.stdout.trim() : "";
      const pushStderr = typeof pushResult.stderr === "string" ? pushResult.stderr.trim() : "";
      console.log(`[autoCommit] git push exit=${pushResult.status} branch=${branchName}`);
      if (pushStdout) console.log(`[autoCommit] push stdout: ${pushStdout.slice(0, 200)}`);
      if (pushStderr) console.log(`[autoCommit] push stderr: ${pushStderr.slice(0, 200)}`);
      if ((pushResult.status ?? 1) !== 0) {
        throw new Error(`git push failed: ${pushStderr || pushStdout || `exit ${pushResult.status ?? "unknown"}`}`);
      }
    }
    return openPullRequest(runSync, flair, options, authorEmail, repo);
  }

  const args = [
    "agent", "commit",
    "--repo", repo,
    "--branch", branchName,
    "--message", commitMessage,
    "--author", authorName, authorEmail,
    ...(push ? ["--push"] : []),
    ...(prTitle && !(openPr && prRepo) ? ["--pr-title", prTitle] : []),
  ];

  const result = runSync(tpsCmd, args, { cwd: repo, encoding: "utf-8" });
  const resultStdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const resultStderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  console.log(`[autoCommit] tps agent commit exit=${result.status} push=${push} branch=${branchName}`);
  if (resultStdout) console.log(`[autoCommit] stdout: ${resultStdout.slice(0, 200)}`);
  if (resultStderr) console.log(`[autoCommit] stderr: ${resultStderr.slice(0, 200)}`);
  if (result.status === 0) {
    return openPullRequest(runSync, flair, options, authorEmail, repo);
  }

  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const errMsg = stderr || stdout || `exit ${result.status ?? "unknown"}`;

  if (result.status === 2) {
    // Push succeeded but PR creation failed
    try {
      await flair.publishEvent({
        kind: "blocker",
        summary: `PR creation failed for ${taskId}`,
        detail: errMsg,
        refId: taskId,
      });
    } catch { /* non-fatal */ }
  }

  throw new Error(`tps agent commit failed: ${errMsg}`);
}

/** @internal Legacy auto-commit wrapper. */
async function _runAutoCommitLegacy(
  agentId: string,
  workspace: string,
  taskId: string,
  cfg: AutoCommitConfig,
  flair: AutoCommitFlair,
  taskSubject?: string,
  taskBody?: string,
  mailCfg?: RuntimeMailConfig,
): Promise<string | null> {
  const branchPrefix = cfg.branchPrefix ?? "task/";
  const safeBranch = `${branchPrefix}${taskId}`.replace(/[^a-zA-Z0-9._/-]/g, "-");
  const authorName = cfg.authorName ?? agentId;
  const authorEmail = cfg.authorEmail ?? `${agentId}@tps.dev`;
  const tpsBin = join(homeDir(), ".tps", "bin", "tps");
  const tpsCommand = existsSync(tpsBin) ? tpsBin : undefined;
  const ghAgent = cfg.githubPat
    ? basename(cfg.githubPat).replace(/-github-pat(?:\.[^.]+)?$/, "").replace(/\.[^.]+$/, "")
    : undefined;

  console.log(`[${agentId}] Auto-commit: ${safeBranch} in ${workspace}`);
  try {
    const prUrl = await runAutoCommit(
      { workspace },
      flair,
      {
        taskId,
        branchName: safeBranch,
        commitMessage: taskSubject ? `${taskSubject}` : `task complete: ${taskId}`,
        authorName,
        authorEmail,
        push: cfg.push,
        openPr: cfg.openPr,
        prRepo: cfg.prRepo,
        ghAgent,
        prTitle: cfg.prTitle ?? taskSubject ?? `task: ${taskId}`,
        prBody: taskBody ? taskBody.split('\n\n')[0].slice(0, 500) : undefined,
        reviewNotify: cfg.reviewNotify,
        signCfg: mailCfg,
      },
      { tpsCommand },
    );
    console.log(`[${agentId}] Auto-commit succeeded: ${safeBranch}`);
    return prUrl ?? null;
  } catch (e) {
    const err = e as Error;
    console.warn(`[${agentId}] Auto-commit failed (non-fatal): ${err.message}`);
    if (err.stack) console.warn(`[${agentId}] Auto-commit stack: ${err.stack.slice(0, 400)}`);
    return null;
  }
}


/** How often the runtime publishes a Presence heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** Upper bound on the final shutdown beat before the process exits. */
export const SHUTDOWN_BEAT_TIMEOUT_MS = 3000;
/** Total bound for draining loop stops before the final beat. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = SHUTDOWN_BEAT_TIMEOUT_MS;

/**
 * The Flair key path the runtime authenticates with: the configured path, else
 * the locally resolved agent key — the same candidate order the rest of the CLI uses
 * (agent-keys.ts). Falls back to the first candidate so a missing key fails with
 * the client's named path error.
 */
export function resolveRuntimeKeyPath(agentId: string, configured?: string): string {
  if (configured) return configured;
  return resolveAgentKeyPath(agentId) ?? (agentKeyCandidates(agentId)[0] as string);
}

/**
 * Publish ONE presence heartbeat for the agent on Flair's Presence resource,
 * signed with the agent's own Ed25519 credential. cli#444: liveness is recorded
 * HERE, never by writing the agent's `Agent.status` — in Flair that field is the
 * principal's lifecycle state (a value other than `active` deactivates it). A
 * failure only LOGS (never throws) and never writes `/Agent`.
 */
export async function publishRuntimePresence(
  client: Pick<FlairClient, "presence">,
  agentId: string,
  activity?: PresenceActivity,
): Promise<void> {
  try {
    await client.presence(activity);
  } catch (e: any) {
    console.warn(`[${agentId}] presence heartbeat failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Start the runtime's Presence heartbeat: ONE beat at startup, then one every
 * `intervalMs`, on the timer's own schedule. Returns a stop function that clears
 * the timer.
 */
export function startPresenceHeartbeat(
  client: Pick<FlairClient, "presence">,
  agentId: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  void publishRuntimePresence(client, agentId);
  const timer = setInterval(() => {
    void publishRuntimePresence(client, agentId);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

/**
 * The final Presence beat on shutdown: a bounded `"idle"` beat. Never throws;
 * resolves when the beat settles or `timeoutMs` elapses, whichever comes first.
 */
export async function shutdownPresenceBeat(
  client: Pick<FlairClient, "presence">,
  agentId: string,
  timeoutMs: number = SHUTDOWN_BEAT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([publishRuntimePresence(client, agentId, "idle"), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drainLoopStops(
  stops: Array<() => void | Promise<void>>,
  timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const stop of stops) {
    try {
      pending.push(Promise.resolve(stop()));
    } catch {
      // Continue stopping the remaining loops.
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Call loop stops, bound the drain, then send the bounded final beat and exit once. */
export function shutdownHandler(
  client: Pick<FlairClient, "presence">,
  agentId: string,
  stopHeartbeat: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
  timeoutMs: number = SHUTDOWN_BEAT_TIMEOUT_MS,
  stops: Array<() => void | Promise<void>> = [],
  drainTimeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS,
): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopHeartbeat();
    void (async () => {
      await drainLoopStops(stops, drainTimeoutMs);
      await shutdownPresenceBeat(client, agentId, timeoutMs);
      exit(0);
    })();
  };
}

/** How many times publishing a pr.opened event is attempted before it is logged and dropped. */
export const PR_RESULT_PUBLISH_ATTEMPTS = 3;
/** The delay between pr.opened publication attempts. */
export const PR_RESULT_PUBLISH_RETRY_MS = 250;

/**
 * Attempt to publish the PR URL as a `pr.opened` OrgEvent targeted at the agent,
 * up to `PR_RESULT_PUBLISH_ATTEMPTS` times. Only an accepted POST can reach the
 * review loop; exhausted retries call `console.warn` with the PR URL and return
 * without an event if no POST was accepted. Flair assigns a fresh id per POST,
 * so a retry after an uncertain response can publish the event twice.
 */
export async function publishPrResult(
  flair: Pick<FlairClient, "request">,
  agentId: string,
  taskId: string,
  prUrl: string | null,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (!prUrl) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const event = {
    kind: "pr.opened", authorId: agentId, targetIds: [agentId],
    summary: `PR opened for ${taskId}`, refId: taskId,
    detail: prUrl,
  };
  for (let attempt = 1; attempt <= PR_RESULT_PUBLISH_ATTEMPTS; attempt++) {
    try {
      await flair.request("POST", "/OrgEvent", event);
      return;
    } catch (e) {
      const message = (e as Error).message;
      if (attempt < PR_RESULT_PUBLISH_ATTEMPTS) {
        console.warn(`[${agentId}] Failed to publish pr.opened for ${prUrl} (attempt ${attempt}/${PR_RESULT_PUBLISH_ATTEMPTS}): ${message}; retrying`);
        await sleep(PR_RESULT_PUBLISH_RETRY_MS);
      } else {
        console.warn(`[${agentId}] Failed to publish pr.opened for ${prUrl} after ${attempt} attempts: ${message}`);
      }
    }
  }
}

export async function runCodexRuntime(config: CodexRuntimeConfig): Promise<void> {
  const { agentId, workspace, flairUrl, flairKeyPath, workspaceProvider } = config;
  writeFileSync(join(workspace, ".tps-agent.pid"), `${process.pid}\n`, "utf-8");
  console.log(`[${agentId}] Codex runtime started. Polling the ${agentId} mailbox`);

  await ensureFreshOpenAIToken(agentId);

  // cli#444: a generated agent config omits flair.keyPath; resolve the agent's
  // locally resolved agent key (the same candidates the rest of the CLI uses) so the
  // Presence beats are signed.
  const keyPath = resolveRuntimeKeyPath(agentId, flairKeyPath);
  const taskConfig: CodexRuntimeConfig = keyPath === flairKeyPath ? config : { ...config, flairKeyPath: keyPath };
  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath });
  const mailCfg: RuntimeMailConfig = { agentId, flairUrl, flairKeyPath: keyPath };

  // All runtime outbound mail goes through the SIGNED path; a send failure must
  // not abort a task that otherwise completed.
  // Sender notices are ATTEMPTS: notify() logs a failed signed-mail send;
  // the completion boundary still attempts acknowledgement.
  const notify = (to: string, body: string) => {
    try { sendRuntimeMail(mailCfg, to, body); }
    catch (e: any) { console.warn(`[${agentId}] outbound mail to ${to} failed: ${e.message}`); }
  };

  // cli#444: liveness goes to Flair's Presence resource, never to the agent's
  // Agent row — `Agent.status` is the principal's lifecycle state (a value other
  // than `active` deactivates it). The heartbeat runs on its own timer from
  // startup, independent of the mail loop; the signal handlers await the bounded
  // final beat before exiting.
  const stopHeartbeat = startPresenceHeartbeat(flair, agentId);
  const stopHandles: Array<() => void | Promise<void>> = [];
  let shutdownRequested = false;
  const removeSignalListeners = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  let shutdownComplete: Promise<void> | undefined;
  const shutdown = () => {
    if (!shutdownComplete) {
      stopHeartbeat();
      shutdownComplete = (async () => {
        await drainLoopStops(stopHandles);
        if (shutdownRequested) await shutdownPresenceBeat(flair, agentId);
        removeSignalListeners();
        if (shutdownRequested) process.exit(0);
      })();
    }
    return shutdownComplete;
  };
  const onSignal = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const flairOnline = await runtimeBootPreflight(flair, agentId);
    if (flairOnline) {
      await snapshotSoulToDisk(flair, agentId);
    } else {
      const fallback = getFallbackSoulPath(agentId);
      console.warn(`[${agentId}] using disk fallback: ${existsSync(fallback) ? fallback : "NONE"}`);
    }

    try {
      const caught = await catchUpTopics(agentId, undefined, mailCfg);
      if (caught > 0) console.log(`[${agentId}] Caught up ${caught} missed topic message(s)`);
    } catch (err: any) {
      console.warn(`[${agentId}] Topic catch-up failed: ${err.message}`);
    }

    if (workspaceProvider) {
      try {
        const { lastCheckpoint } = await onBoot(workspaceProvider, flair, agentId);
        if (lastCheckpoint) console.log(`[${agentId}] Resumed from: ${lastCheckpoint.label ?? lastCheckpoint.ref}`);
      } catch (err: any) {
        console.warn(`[${agentId}] Boot lifecycle failed (non-fatal): ${err.message}`);
      }
      try {
        const base = await workspaceProvider.baseline();
        await workspaceProvider.reset(base);
        console.log(`[${agentId}] Workspace reset to baseline: ${base.label ?? base.ref.slice(0, 7)}`);
      } catch (err: any) {
        console.error(`[${agentId}] Workspace baseline reset failed: ${err.message}`);
        throw err;
      }
    }
    if (shutdownRequested) {
      await shutdown();
      return;
    }

    // Start Flair task loop (runs in parallel with mail loop)
    stopHandles.push(startTaskLoop(flair, agentId, async (event) => {
      const taskBody = event.detail ?? event.summary;
      const taskId = event.refId ?? event.id;
      let preTaskState: WorkspaceState | undefined;
      if (workspaceProvider) {
        try { preTaskState = await onTaskStart(workspaceProvider, flair, taskId); } catch (e) {
          console.warn(`[${agentId}] Pre-task lifecycle failed: ${(e as Error).message}`);
        }
      }
      try {
        const msg: MailMessage = { id: taskId, from: event.authorId, to: agentId, body: taskBody, timestamp: new Date().toISOString() };
        const flairPub1 = { publishEvent: async (ev: Record<string, unknown>) => {
          try { await (flair as any).request("POST", "/OrgEvent", { ...ev, authorId: agentId }); } catch { /* non-fatal */ }
        }};
        const result = await runCodex(msg, taskConfig, config.taskTimeoutMs ?? 30 * 60 * 1000, {
          flairPublisher: flairPub1,
          onStall: () => { notify(event.authorId, `Task stalled: no Codex output for ${Math.round((config.watchdogTimeoutMs ?? 300000) / 60000)}m — process killed. Please resend the task.`); },
        });
        const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
        console.log(`[${agentId}] Flair task complete. Result: ${result.length} chars`);
        if (shouldSendTaskCompletion(event.authorId, config.autoCommit?.reviewNotify)) {
          notify(event.authorId, formatTaskCompleteMailBody(summary, "Task complete (via Flair)"));
        }
        try {
          await (flair as any).request("POST", "/OrgEvent", {
            kind: "task.completed", authorId: agentId, targetIds: [event.authorId],
            summary: `Completed: ${event.summary}`, refId: taskId, scope: event.scope,
          });
        } catch { /* non-fatal */ }
        if (workspaceProvider && preTaskState) {
          try { await onTaskComplete(workspaceProvider, flair, taskId, preTaskState); } catch (e) {
            console.warn(`[${agentId}] Post-task lifecycle failed: ${(e as Error).message}`);
          }
        } else {
          await writeTaskMemory(flair, agentId, "completion", { task: taskBody, summary });
        }
        // Auto-commit if configured — _runAutoCommitLegacy handles detached HEAD + blocker on exit 2
        if (config.autoCommit) {
          const flairPublisher = { publishEvent: async (ev: Record<string, unknown>) => {
            try { await (flair as any).request("POST", "/OrgEvent", { ...ev, authorId: agentId }); } catch { /* non-fatal */ }
          }};
          const prUrl = await _runAutoCommitLegacy(agentId, resolveCommitRepo(config), taskId, config.autoCommit, flairPublisher, taskBody?.split("\n")[0].slice(0, 72), taskBody, mailCfg);
          await publishPrResult(flair, agentId, taskId, prUrl);
        }
      } catch (e) {
        const err = e as Error;
        console.error(`[${agentId}] Flair task failed:`, err.message);
        notify(event.authorId, `Task failed (via Flair): ${err.message}`);
        await publishTaskOutcomeEvent(flair, agentId, {
          kind: "task.failed",
          summary: `Task ${taskId} failed: ${err.message.slice(0, 200)}`,
          refId: taskId,
        });
        if (workspaceProvider && preTaskState) {
          try { await onTaskFailure(workspaceProvider, flair, taskId, preTaskState, err.message); } catch { /* */ }
        } else {
          await writeTaskMemory(flair, agentId, "failure", { task: taskBody, error: err.message });
        }
      }
    }).stop);

    // Review trigger — polls the agent's own feed using a different cursor filename from the task loop.
    if (config.reviewTrigger) {
      stopHandles.push(startReviewTriggerLoop(flair, agentId, config.reviewTrigger).stop);
      console.log(`[${agentId}] Review trigger active → ${config.reviewTrigger.reviewers.join(", ")}`);
    }

    let lastSnapshot = Date.now();
    let lastTokenRefresh = Date.now();
    const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // check every 30min
    while (!shutdownRequested) {
      if (Date.now() - lastTokenRefresh > TOKEN_REFRESH_INTERVAL_MS) {
        await ensureFreshOpenAIToken(agentId);
        lastTokenRefresh = Date.now();
      }
      if (Date.now() - lastSnapshot > FLAIR_SNAPSHOT_INTERVAL_MS && await flair.ping()) {
        await snapshotSoulToDisk(flair, agentId);
        lastSnapshot = Date.now();
      }
      if (shutdownRequested) break;
      for (const msg of await pollRuntimeMail(mailCfg)) {
        if (shutdownRequested) break;
        console.log(`[${agentId}] Processing mail from ${msg.from}: ${msg.body.slice(0, 60)}...`);
        const refusal = codexDispatchRefusal(msg.envelope, msg.from, msg.trustTier);
        if (refusal) {
          console.warn(`[${agentId}] ${refusal}; not dispatched`);
          continue;
        }
        let preTaskState;
        if (workspaceProvider) {
          try { preTaskState = await onTaskStart(workspaceProvider, flair, msg.id); } catch (err: any) {
            console.warn(`[${agentId}] Pre-task lifecycle failed: ${err.message}`);
          }
        }
        if (shutdownRequested) break;
        try {
          const flairPub2 = { publishEvent: async (ev: Record<string, unknown>) => {
            try { await (flair as any).request("POST", "/OrgEvent", { ...ev, authorId: agentId }); } catch { /* non-fatal */ }
          }};
          // Choose the commit repository ONCE: every probe and the rebase abort
          // below run against this repository, so a configured override is used
          // for all of them.
          const commitRepo = config.autoCommit ? resolveCommitRepo(config) : undefined;
          const baseline = commitRepo ? probeHead(commitRepo) : undefined;
          const result = await runCodex(msg, taskConfig, config.taskTimeoutMs ?? 30 * 60 * 1000, {
            flairPublisher: flairPub2,
            onStall: () => { notify(msg.from, `Task stalled: no Codex output for ${Math.round((config.watchdogTimeoutMs ?? 300000) / 60000)}m — process killed. Please resend the task.`); },
          });
          const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
          console.log(`[${agentId}] Task complete. Result length: ${result.length}`);
          if (shouldSendTaskCompletion(msg.from, config.autoCommit?.reviewNotify)) {
            notify(msg.from, formatTaskCompleteMailBody(summary));
          }
          await publishTaskOutcomeEvent(flair, agentId, {
            kind: "task.completed",
            summary: `Task ${msg.id} completed by ${agentId}`,
            refId: msg.id,
          });
          if (workspaceProvider && preTaskState) {
            try { await onTaskComplete(workspaceProvider, flair, msg.id, preTaskState); } catch (err: any) {
              console.warn(`[${agentId}] Post-task lifecycle failed: ${err.message}`);
            }
          } else {
            await writeTaskMemory(flair, agentId, "completion", { task: msg.body, summary });
          }
          // Auto-commit after a mail task. Unlike the Flair task path above,
          // the mail path detects and aborts an interrupted rebase in the
          // commit repository, keeps the pre-task HEAD as the comparison when
          // the repository has one (a restored HEAD different from it causes a
          // commit attempt), and probes Git status and HEAD before deciding.
          if (config.autoCommit && commitRepo !== undefined) {
            const flairPublisher = { publishEvent: async (ev: Record<string, unknown>) => {
              try { await (flair as any).request("POST", "/OrgEvent", { ...ev, authorId: agentId }); } catch { /* non-fatal */ }
            }};
            const decision = evaluateMailAutoCommitGate(commitRepo, baseline);
            if (decision.action === "skip") {
              console.warn(`[${agentId}] ${decision.message}`);
              notify(msg.from, decision.message);
            } else if (decision.action === "clean") {
              console.warn(`[${agentId}] ${decision.message}`);
              notify(msg.from,
                `Task complete but ${decision.message}.\n\nThe implementation may have failed silently (e.g. test timeout, Codex exhausted context exploring). Please re-spec with exact file paths and line numbers.\n\nTask: ${msg.body.slice(0, 200)}`
              );
            } else {
              const mailSubject = msg.body.split("\n")[0].slice(0, 72);
              const prUrl = await _runAutoCommitLegacy(agentId, commitRepo, msg.id, config.autoCommit, flairPublisher, mailSubject, msg.body, mailCfg);
              await publishPrResult(flair, agentId, msg.id, prUrl);
            }
          }
        } catch (err: any) {
          console.error(`[${agentId}] Task failed:`, err.message);
          notify(msg.from, `Task failed: ${err.message}`);
          await publishTaskOutcomeEvent(flair, agentId, {
            kind: "task.failed",
            summary: `Task ${msg.id} failed: ${String(err.message ?? err).slice(0, 200)}`,
            refId: msg.id,
          });
          if (workspaceProvider && preTaskState) {
            try { await onTaskFailure(workspaceProvider, flair, msg.id, preTaskState, err.message); } catch {}
          } else {
            await writeTaskMemory(flair, agentId, "failure", { task: msg.body, error: err.message });
          }
        } finally {
          // Completion boundary end — AFTER the reply attempt and any auto-commit
          // work has finished. Acking here is what stops cli#377's lease sweep
          // re-presenting — and re-dispatching — a finished task forever.
          completeRuntimeMail(mailCfg, msg.id);
        }
      }

      if (shutdownRequested) break;
      await new Promise(r => setTimeout(r, 5000));
    }
  } finally {
    await shutdown();
  }
}
