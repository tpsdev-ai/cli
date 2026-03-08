/**
 * codex-runtime.ts — Agent runtime backed by the Codex CLI (codex exec --json).
 * Uses ChatGPT OAuth credentials; no OpenAI API key required.
 * Same interface as claude-code-runtime.ts.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync, existsSync, mkdirSync, readdirSync,
  renameSync, writeFileSync, appendFileSync, createWriteStream,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { FlairClient } from "./flair-client.js";
import {
  snapshotSoulToDisk,
  bootContext,
  searchPastExperience,
  writeTaskMemory,
  catchUpTopics,
  onBoot,
  onTaskStart,
  onTaskComplete,
  onTaskFailure,
} from "./agent-lifecycle.js";
import {
  refreshOpenAIToken,
  type StoredCredentials,
} from "../commands/auth.js";
import type { WorkspaceProvider, WorkspaceState } from "./workspace-provider.js";
import { startTaskLoop } from "./flair-task-loop.js";
import { handlePrOpened } from "./pr-review-trigger.js";
import { formatTaskCompleteMailBody } from "./task-result-mail.js";

/** Real git binary path — bypasses codex-tools wrapper that blocks commit/push */
const GIT_BIN = process.env.TPS_GIT_BIN ?? "/usr/bin/git";

/** Read OpenAI OAuth creds from ~/.tps/auth/openai.json (written by tps auth login openai). */
function readStoredOpenAICreds(): StoredCredentials | null {
  const credPath = join(homedir(), ".tps", "auth", "openai.json");
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
  /** Repository path to commit changes in (defaults to workspace) */
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
  sessionLogPath?: string;
  flairUrl?: string;
  flairKeyPath: string;
  workspaceProvider?: WorkspaceProvider;
  /** If set, auto-commit workspace changes after each task completes */
  autoCommit?: AutoCommitConfig;
  /** If set, listen for pr.opened events and auto-request reviews */
  reviewTrigger?: { reviewers: string[]; repo: string };
}

interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

function getMailPaths(mailDir: string, agentId: string) {
  const root = join(mailDir, agentId);
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  const tmp = join(root, "tmp");
  const outbox = join(root, "outbox");
  for (const d of [fresh, cur, tmp, outbox]) mkdirSync(d, { recursive: true });
  return { fresh, cur, tmp, outbox };
}

function checkNewMail(mailDir: string, agentId: string): MailMessage[] {
  const { fresh, cur } = getMailPaths(mailDir, agentId);
  const files = readdirSync(fresh).filter(f => f.endsWith(".json") && !f.startsWith("."));
  const messages: MailMessage[] = [];
  for (const file of files) {
    const src = join(fresh, file);
    const dst = join(cur, file);
    try {
      const msg = JSON.parse(readFileSync(src, "utf-8")) as MailMessage;
      renameSync(src, dst);
      messages.push(msg);
    } catch {}
  }
  return messages;
}

function sendMail(mailDir: string, from: string, to: string, body: string): void {
  const { fresh: recipientFresh, tmp: recipientTmp } = getMailPaths(mailDir, to);
  const id = randomUUID();
  const ts = new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  const msg: MailMessage = { id, from, to, body, timestamp: ts };
  const tmpPath = join(recipientTmp, filename);
  const newPath = join(recipientFresh, filename);
  writeFileSync(tmpPath, JSON.stringify(msg, null, 2), "utf-8");
  renameSync(tmpPath, newPath);
}

async function buildSystemPrompt(
  message: MailMessage,
  config: CodexRuntimeConfig,
): Promise<string> {
  const { agentId, workspace, extraDirs, supervisorId, flairUrl, flairKeyPath } = config;
  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });
  const allowedTools = ["Bash", "Read", "Write", "Edit"];
  const { systemPrompt } = await bootContext(
    flair, agentId, message.body.slice(0, 100), workspace,
    { allowedTools, supervisorId },
  );
  const experience = await searchPastExperience(flair, message.body, workspace);
  return experience ? systemPrompt + "\n\n" + experience : systemPrompt;
}

async function runCodex(
  message: MailMessage,
  config: CodexRuntimeConfig,
  taskTimeoutMs: number,
): Promise<string> {
  await syncWorkspaceBeforeTask(config);
  const systemPrompt = await buildSystemPrompt(message, config);
  const sandboxMode = config.sandboxMode ?? "workspace-write";

  const prompt = [systemPrompt, "", `[Mail from: ${message.from}]`, message.body].join("\n");

  const args = [
    "exec", "--json", "--ephemeral",
    ...(config.model ? ["--model", config.model] : []),
    "--sandbox", sandboxMode,
    "--cd", config.workspace,
    "-",
  ];
  for (const dir of config.extraDirs ?? []) args.push("--add-dir", dir);

  const logPath = config.sessionLogPath ?? join(homedir(), ".tps", "agents", config.agentId, "session.log");
  appendFileSync(logPath, `\n${"=".repeat(60)}\n[${new Date().toISOString()}] Task from ${message.from} (codex)\n${"=".repeat(60)}\n`, "utf-8");
  const logStream = createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve, reject) => {
    const codexToolsDir = join(homedir(), ".tps", "bin", "codex-tools");
    const codexEnv = { ...process.env, PATH: `${codexToolsDir}:${process.env.PATH ?? ""}` };
    const proc = spawn("codex", args, { cwd: config.workspace, env: codexEnv });
    proc.stdin.write(prompt);
    proc.stdin.end();

    let resultMessages: string[] = [];
    let turnCount = 0;
    let stderr = "";
    let buf = "";

    proc.stdout.on("data", (d: Buffer) => {
      logStream.write(d);
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
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

    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); logStream.write(d); });

    const timeout = setTimeout(() => proc.kill("SIGTERM"), taskTimeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timeout);
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
}

export interface AutoCommitDeps {
  spawnSyncImpl?: typeof spawnSync;
  tpsCommand?: string;
}

export interface WorkspaceSyncDeps {
  spawnSyncImpl?: typeof spawnSync;
  warn?: (message?: any, ...optionalParams: any[]) => void;
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

  // Ensure we're on a named branch (worktrees start detached via git worktree add --detach)
  const headCheck = runSync(GIT_BIN, ["symbolic-ref", "--quiet", "HEAD"], { cwd: config.workspace, encoding: "utf-8" });
  if ((headCheck.status ?? 1) !== 0) {
    runSync(GIT_BIN, ["checkout", branch], { cwd: config.workspace, encoding: "utf-8" });
  }
  const result = runSync(GIT_BIN, ["pull", "--rebase", "origin", branch], {
    cwd: config.workspace,
    encoding: "utf-8",
  });

  if ((result.status ?? 1) === 0) return;

  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const detail = stderr || stdout || `exit ${result.status ?? "unknown"}`;
  warn(`[${config.agentId}] Workspace sync failed before task (non-fatal): git pull --rebase origin ${branch}: ${detail}`);
}

export async function runAutoCommit(
  config: Pick<CodexRuntimeConfig, "workspace">,
  flair: AutoCommitFlair,
  options: AutoCommitOptions,
  deps: AutoCommitDeps = {},
): Promise<void> {
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
  if (result.status === 0) {
    if (push && openPr && prRepo) {
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
      const prResult = runSync("gh-as", prArgs, { cwd: repo, encoding: "utf-8" });
      if ((prResult.status ?? 1) === 0) return;

      const prStderr = typeof prResult.stderr === "string" ? prResult.stderr.trim() : "";
      const prStdout = typeof prResult.stdout === "string" ? prResult.stdout.trim() : "";
      const prErrMsg = prStderr || prStdout || `exit ${prResult.status ?? "unknown"}`;
      try {
        await flair.publishEvent({
          kind: "blocker",
          summary: `PR creation failed for ${taskId}`,
          detail: prErrMsg,
          refId: taskId,
        });
      } catch { /* non-fatal */ }
      throw new Error(`gh-as pr create failed: ${prErrMsg}`);
    }
    return;
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

/** @internal Legacy inline auto-commit for the mail loop. Wraps runAutoCommit. */
async function _runAutoCommitLegacy(
  agentId: string,
  workspace: string,
  taskId: string,
  cfg: AutoCommitConfig,
  flair: AutoCommitFlair,
  taskSubject?: string,
  taskBody?: string,
): Promise<string | null> {
  const branchPrefix = cfg.branchPrefix ?? "task/";
  const safeBranch = `${branchPrefix}${taskId}`.replace(/[^a-zA-Z0-9._/-]/g, "-");
  const authorName = cfg.authorName ?? agentId;
  const authorEmail = cfg.authorEmail ?? `${agentId}@tps.dev`;
  const tpsBin = join(homedir(), ".tps", "bin", "tps");
  const tpsCommand = existsSync(tpsBin) ? tpsBin : undefined;
  const ghAgent = cfg.githubPat
    ? basename(cfg.githubPat).replace(/-github-pat(?:\.[^.]+)?$/, "").replace(/\.[^.]+$/, "")
    : undefined;

  console.log(`[${agentId}] Auto-commit: ${safeBranch} in ${workspace}`);
  try {
    await runAutoCommit(
      { workspace: cfg.repo ?? workspace },
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
        prBody: taskBody,
      },
      { tpsCommand },
    );
    console.log(`[${agentId}] Auto-commit succeeded: ${safeBranch}`);
    return safeBranch;
  } catch (e) {
    const err = e as Error;
    console.warn(`[${agentId}] Auto-commit failed (non-fatal): ${err.message}`);
    return null;
  }
}


export async function runCodexRuntime(config: CodexRuntimeConfig): Promise<void> {
  const { agentId, mailDir, workspace, flairUrl, flairKeyPath, workspaceProvider } = config;
  writeFileSync(join(workspace, ".tps-agent.pid"), `${process.pid}\n`, "utf-8");
  console.log(`[${agentId}] Codex runtime started. Polling ${mailDir}/${agentId}/new`);

  await ensureFreshOpenAIToken(agentId);

  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });

  // Mark offline on clean shutdown
  const markOffline = () => {
    try { (flair as any).request("PATCH", `/Agent/${agentId}`, { status: "offline" }).catch(() => {}); } catch {}
  };
  process.once("SIGINT", () => { markOffline(); process.exit(0); });
  process.once("SIGTERM", () => { markOffline(); process.exit(0); });

  const flairOnline = await flair.ping();
  if (flairOnline) {
    console.log(`[${agentId}] Flair online — snapshotting soul to disk`);
    await snapshotSoulToDisk(flair, agentId);
  } else {
    const fallback = join(homedir(), ".tps", "agents", agentId, "fallback", "SOUL.md");
    console.warn(`[${agentId}] ⚠️  Flair offline. Fallback: ${existsSync(fallback) ? fallback : "NONE"}`);
  }

  try {
    const caught = catchUpTopics(agentId);
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


  // Start Flair task loop (runs in parallel with mail loop)
  startTaskLoop(flair, agentId, async (event) => {
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
      const result = await runCodex(msg, config, config.taskTimeoutMs ?? 30 * 60 * 1000);
      const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
      console.log(`[${agentId}] Flair task complete. Result: ${result.length} chars`);
      sendMail(mailDir, agentId, event.authorId, formatTaskCompleteMailBody(summary, "Task complete (via Flair)"));
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
        const branchRef = await _runAutoCommitLegacy(agentId, config.workspace, taskId, config.autoCommit, flairPublisher, taskBody?.split("\n")[0].slice(0, 72), taskBody);
        if (branchRef && config.autoCommit.push) {
          try {
            await (flair as any).request("POST", "/OrgEvent", {
              kind: "pr.opened", authorId: agentId,
              summary: `PR opened for ${taskId}`, refId: taskId,
              detail: branchRef,
            });
          } catch { /* non-fatal */ }
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(`[${agentId}] Flair task failed:`, err.message);
      sendMail(mailDir, agentId, event.authorId, `Task failed (via Flair): ${err.message}`);
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
  });

  // Review trigger — listens for pr.opened and auto-requests K&S review
  if (config.reviewTrigger) {
    const triggerConfig = {
      reviewers: config.reviewTrigger.reviewers,
      agentId,
      repo: config.reviewTrigger.repo,
    };
    startTaskLoop(flair, `${agentId}-review-trigger`, async (event) => {
      await handlePrOpened(event, triggerConfig);
    }, { kinds: ["pr.opened"] });
    console.log(`[${agentId}] Review trigger active → ${config.reviewTrigger.reviewers.join(", ")}`);
  }

  let lastSnapshot = Date.now();
  let lastTokenRefresh = Date.now();
  let lastHeartbeat = 0; // publish on first tick
  const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // check every 30min
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // publish heartbeat every 5min
  while (true) {
    if (Date.now() - lastTokenRefresh > TOKEN_REFRESH_INTERVAL_MS) {
      await ensureFreshOpenAIToken(agentId);
      lastTokenRefresh = Date.now();
    }
    if (Date.now() - lastSnapshot > FLAIR_SNAPSHOT_INTERVAL_MS && await flair.ping()) {
      await snapshotSoulToDisk(flair, agentId);
      lastSnapshot = Date.now();
    }
    // Publish heartbeat to Flair (update agent status + OrgEvent)
    if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      try {
        await (flair as any).request("PATCH", `/Agent/${agentId}`, { status: "online", lastSeen: new Date().toISOString() });
      } catch { /* non-fatal */ }
      lastHeartbeat = Date.now();
    }

    for (const msg of checkNewMail(mailDir, agentId)) {
      console.log(`[${agentId}] Processing mail from ${msg.from}: ${msg.body.slice(0, 60)}...`);
      let preTaskState;
      if (workspaceProvider) {
        try { preTaskState = await onTaskStart(workspaceProvider, flair, msg.id); } catch (err: any) {
          console.warn(`[${agentId}] Pre-task lifecycle failed: ${err.message}`);
        }
      }
      try {
        const result = await runCodex(msg, config, config.taskTimeoutMs ?? 30 * 60 * 1000);
        const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
        console.log(`[${agentId}] Task complete. Result length: ${result.length}`);
        sendMail(mailDir, agentId, msg.from, formatTaskCompleteMailBody(summary));
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
        // Auto-commit after mail task (same as Flair task path)
        if (config.autoCommit) {
          const flairPublisher = { publishEvent: async (ev: Record<string, unknown>) => {
            try { await (flair as any).request("POST", "/OrgEvent", { ...ev, authorId: agentId }); } catch { /* non-fatal */ }
          }};
          const mailSubject = msg.body.split("\n")[0].slice(0, 72);
          await _runAutoCommitLegacy(agentId, config.workspace, msg.id, config.autoCommit, flairPublisher, mailSubject, msg.body);
        }
      } catch (err: any) {
        console.error(`[${agentId}] Task failed:`, err.message);
        sendMail(mailDir, agentId, msg.from, `Task failed: ${err.message}`);
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
      }
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}
