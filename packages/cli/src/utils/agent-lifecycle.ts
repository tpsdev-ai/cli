/**
 * agent-lifecycle.ts — Shared Flair lifecycle hooks for agent runtimes (OPS-47)
 *
 * Extracts boot context, memory search, task memory writes, and topic catch-up
 * from claude-code-runtime.ts so both EventLoop and runClaudeCodeRuntime can
 * call the same hooks without inline duplication.
 *
 * Each function is stateless and takes explicit dependencies (FlairClient,
 * agentId, etc.) rather than holding global state.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { FlairClient } from "./flair-client.js";
import type { WorkspaceStateRecord, OrgEvent } from "./flair-client.js";
import { catchUpTopics as _catchUpTopics } from "./mail-topics.js";
import type { WorkspaceProvider, WorkspaceState } from "./workspace-provider.js";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:agent:lifecycle");


// ── Boot context ───────────────────────────────────────────────────────────

function getFallbackDir(agentId: string): string {
  return join(homedir(), ".tps", "agents", agentId, "fallback");
}

function getFallbackSoulPath(agentId: string): string {
  return join(getFallbackDir(agentId), "SOUL.md");
}

/**
 * Snapshot the agent's soul from Flair to disk for offline fallback.
 */
export async function snapshotSoulToDisk(flair: FlairClient, agentId: string): Promise<void> {
  try {
    const soul = await flair.getSoul();
    if (soul.length === 0) return;

    const fallbackDir = getFallbackDir(agentId);
    mkdirSync(fallbackDir, { recursive: true });

    const content = [
      `# Soul snapshot for ${agentId}`,
      `# Captured: ${new Date().toISOString()}`,
      "",
      ...soul.map(e => `**${e.key}:** ${e.value}`),
    ].join("\n");

    writeFileSync(getFallbackSoulPath(agentId), content, "utf-8");
  } catch {
    // non-fatal
  }
}

/**
 * Build boot context: identity (from Flair or disk fallback) + runtime block.
 * Returns { systemPrompt, identitySource } for the runtime to use.
 */
export async function bootContext(
  flair: FlairClient,
  agentId: string,
  taskQuery: string,
  workspace: string,
  opts?: {
    allowedTools?: string[];
    supervisorId?: string;
  },
): Promise<{ systemPrompt: string; identitySource: "flair" | "disk" }> {
  const parts: string[] = [];
  let identitySource: "flair" | "disk" | null = null;

  const flairOnline = await flair.ping();

  if (flairOnline) {
    try {
      const context = await flair.bootstrap({ query: taskQuery });
      if (context.trim()) {
        parts.push(context);
        identitySource = "flair";
      }
    } catch {
      // fall through to disk
    }
  }

  if (identitySource !== "flair") {
    const fallbackPath = getFallbackSoulPath(agentId);
    if (existsSync(fallbackPath)) {
      const content = readFileSync(fallbackPath, "utf-8").trim();
      if (content) {
        parts.push(content.slice(0, 2000));
        identitySource = "disk";
        swarn(`[${agentId}] ⚠️  Flair offline — using stale disk fallback (${fallbackPath})`);
      }
    }

    if (identitySource !== "disk") {
      const workspaceSoul = join(workspace, "SOUL.md");
      if (existsSync(workspaceSoul)) {
        const content = readFileSync(workspaceSoul, "utf-8").trim();
        if (content) {
          parts.push(content.slice(0, 2000));
          identitySource = "disk";
          swarn(`[${agentId}] ⚠️  Flair offline — using workspace SOUL.md fallback`);
        }
      }
    }
  }

  if (identitySource === null) {
    throw new Error(
      `No system prompt available: Flair offline and no disk fallback found. ` +
      `Run: tps agent soul --id ${agentId} to seed Flair, or create a fallback at ${getFallbackSoulPath(agentId)}`
    );
  }

  // Runtime context block
  const tools = (opts?.allowedTools ?? ["Bash", "Read", "Write", "Edit"]).join(", ");
  const supervisor = opts?.supervisorId ?? "host";
  parts.push(`
## Runtime Context

You are running as agent \`${agentId}\` via Claude Code CLI.
Your workspace: ${workspace}
Tools available: ${tools}
System prompt sourced from: ${identitySource === "flair" ? "Flair (live)" : "⚠️ disk fallback"}

When you finish a task, use Bash to send mail:
  cd ${workspace} && tps mail send ${supervisor} "done: <summary>"

Do NOT run git add, git commit, or git push — the TPS runtime commits and opens a PR automatically after you reply. Just edit the files and send mail when done."
`.trim());

  return { systemPrompt: parts.join("\n\n"), identitySource };
}

// ── Past experience search ─────────────────────────────────────────────────

/**
 * Search Flair for relevant past experience. Returns a formatted block
 * suitable for appending to the system prompt, or empty string.
 */
export async function searchPastExperience(
  flair: FlairClient,
  taskDescription: string,
  workspacePath?: string,
): Promise<string> {
  // Try Flair search first
  try {
    const flairOnline = await flair.ping();
    if (flairOnline) {
      const searchResults = await flair.search(taskDescription.slice(0, 200), 5);
      if (searchResults.length > 0) {
        const experienceBlock = searchResults
          .map(r => `- ${r.content?.slice(0, 200) ?? r.id}`)
          .join("\n");
        return `## Relevant Past Experience\n${experienceBlock}`;
      }
    }
  } catch (err: any) {
    swarn("[flair] search failed (non-fatal):", err.message);
  }

  // Fallback: read MEMORY.md from workspace
  if (workspacePath) {
    const memPath = join(workspacePath, "MEMORY.md");
    if (existsSync(memPath)) {
      const content = readFileSync(memPath, "utf-8").trim();
      if (content) {
        swarn("[flair] Using MEMORY.md fallback for past experience");
        return `## Past Experience (from MEMORY.md)\n${content.slice(0, 3000)}`;
      }
    }
  }

  return "";
}

// ── Task memory writes ─────────────────────────────────────────────────────

/**
 * Write structured task memory to Flair. Non-blocking with 5s timeout.
 */
export async function writeTaskMemory(
  flair: FlairClient,
  agentId: string,
  type: "completion" | "failure",
  data: {
    task: string;
    summary?: string;
    error?: string;
    durationMs?: number;
    workspaceRef?: string;
    files?: string[];
  },
): Promise<void> {
  try {
    const memId = `${agentId}-${Date.now()}`;
    const timeout = new Promise<void>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000));

    const memory = JSON.stringify({
      type: type === "completion" ? "task_completion" : "task_failure",
      task: data.task.slice(0, 80),
      ...(data.summary ? { summary: data.summary.slice(0, 500) } : {}),
      ...(data.error ? { error: data.error.slice(0, 200) } : {}),
      ...(data.durationMs != null ? { durationMs: data.durationMs } : {}),
      ...(data.workspaceRef ? { workspaceRef: data.workspaceRef } : {}),
      ...(data.files ? { files: data.files } : {}),
      timestamp: new Date().toISOString(),
    });

    await Promise.race([flair.writeMemory(memId, memory), timeout]);
  } catch (err: any) {
    swarn(`[${agentId}] Flair ${type} memory write failed (non-fatal):`, err.message);
  }
}


// ── Agent start/stop lifecycle (OPS-54) ────────────────────────────────────

export interface AgentLifecycleResult {
  changed: boolean;
  reason: string;
  /**
   * Absolute path of the created worktree's git directory. Present only when
   * this call created the worktree and deferred its checkout to the caller
   * (cli#516): the caller needs it to grant the checking-out side access.
   */
  gitDir?: string;
  /** Absolute path of the base repository the worktree belongs to. Present in
   *  the same case as `gitDir`. */
  baseRepo?: string;
}

/**
 * A worktree setup, checkout or cleanup operation failed (cli#516). Named so a
 * caller can tell a worktree failure from any other error and report it as one;
 * the message names the operation that failed. Only a failed git operation
 * raises it: a workspace with no base repository is reported as changed:false.
 */
export class WorktreeLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeLifecycleError";
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  // No inherited GIT_* variables, no system or global config: the base
  // repository's own config is the only one in play, and worktree add overrides
  // the hook path explicitly below.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const out = spawnSync("git", args, { cwd, encoding: "utf-8", env: gitEnv() });
  return {
    ok: out.status === 0,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  };
}

/**
 * The result of probing a candidate base repository (cli#516).
 *
 *   repo        — a work tree (the probe succeeded and said so)
 *   not-a-repo  — CONFIRMED absent, or CONFIRMED outside any work tree
 *   error       — the probe failed on a path that exists (broken repository,
 *                 bad config, unreadable metadata): unknown, never "no base"
 */
type RepoProbe =
  | { kind: "repo" }
  | { kind: "not-a-repo" }
  | { kind: "error"; detail: string };

/**
 * Probe one candidate base repository. Only an absent path or a path git
 * reports as outside any work tree counts as "no base": a failed probe of a
 * path that exists is an error, so a broken managed repository can never be
 * mistaken for an unconfigured workspace and let the launch proceed (cli#516).
 */
function probeRepo(path: string): RepoProbe {
  if (!existsSync(path)) return { kind: "not-a-repo" };
  const out = git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (out.ok) return out.stdout === "true" ? { kind: "repo" } : { kind: "not-a-repo" };
  if (/not a git repository/i.test(out.stderr)) return { kind: "not-a-repo" };
  return { kind: "error", detail: out.stderr || out.stdout || "git probe produced no output" };
}

function parseWorktreePaths(baseRepo: string): Set<string> {
  const out = git(baseRepo, ["worktree", "list", "--porcelain"]);
  if (!out.ok) {
    throw new WorktreeLifecycleError(
      `worktree listing failed in ${baseRepo}: ${out.stderr || out.stdout || "git worktree list failed"}`,
    );
  }
  const paths = new Set<string>();
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(resolve(line.slice("worktree ".length).trim()));
    }
  }
  return paths;
}

function resolveBaseRepo(workspacePath: string): string | null {
  const candidates = [
    resolve(join(homedir(), "ops", "tps")),
    resolve(join(dirname(workspacePath), "tps")),
  ];
  for (const candidate of candidates) {
    const probe = probeRepo(candidate);
    if (probe.kind === "repo") return candidate;
    if (probe.kind === "error") {
      throw new WorktreeLifecycleError(
        `git probe failed for the base repository ${candidate}: ${probe.detail}`,
      );
    }
  }
  return null;
}

/**
 * Create the agent's worktree when the workspace is a worktree of a base
 * repository. A workspace with no base repository is left untouched and
 * reported as changed:false.
 *
 * Nothing the repository configures may execute in the parent process
 * (cli#516): the git invocations pin `core.hooksPath` off and `core.fsmonitor`
 * off, and with `deferCheckout` the worktree is created with `--no-checkout` so
 * no checkout-time filter runs either. The checkout is then the caller's, and
 * belongs inside the sandbox; `checkoutWorktree` performs it there.
 *
 * Throws `WorktreeLifecycleError` when a git operation fails, including a probe
 * that fails for a path that exists.
 */
export function onStart(
  agentId: string,
  workspacePath?: string,
  opts: { deferCheckout?: boolean } = {},
): AgentLifecycleResult {
  if (!workspacePath) {
    return { changed: false, reason: "no workspace path configured" };
  }

  const workspace = resolve(workspacePath);
  const baseRepo = resolveBaseRepo(workspace);
  if (!baseRepo) {
    return { changed: false, reason: "no base repository for the workspace" };
  }

  if (workspace === baseRepo) {
    return { changed: false, reason: "workspace is base repo; skipping worktree add" };
  }

  const worktrees = parseWorktreePaths(baseRepo);
  if (worktrees.has(workspace)) {
    return { changed: false, reason: "worktree already exists" };
  }

  if (existsSync(workspace)) {
    return { changed: false, reason: "workspace exists but is not a worktree; leaving untouched" };
  }

  // onStart is called BEFORE the sandbox is entered (cli#516), so no executable
  // the base repository configures may run here: `git worktree add` would run
  // `post-checkout`, the configured fsmonitor, and any configured smudge filter.
  // The two hooks are pinned off below, and a caller that has a sandbox to run
  // the checkout in passes `deferCheckout`, which suppresses the checkout — and
  // with it the filter; `checkoutWorktree` performs it inside the sandbox.
  const defer = opts.deferCheckout === true;
  const args = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "worktree",
    "add",
    ...(defer ? ["--no-checkout"] : []),
    workspace,
    "--detach",
  ];
  const add = git(baseRepo, args);
  if (!add.ok) {
    throw new WorktreeLifecycleError(
      `worktree setup failed for ${agentId} (${baseRepo} -> ${workspace}): ${add.stderr || add.stdout}`,
    );
  }

  if (!defer) {
    return { changed: true, reason: "worktree created" };
  }

  const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok || !gitDir.stdout) {
    throw new WorktreeLifecycleError(
      `worktree git directory could not be resolved for ${workspace}: ${gitDir.stderr || gitDir.stdout || "git rev-parse produced no output"}`,
    );
  }
  return { changed: true, reason: "worktree created; checkout deferred", gitDir: gitDir.stdout, baseRepo };
}

/**
 * Populate a worktree the parent created with `--no-checkout` (cli#516). This
 * checkout reads the base repository's tree and runs whatever filter and hook
 * the repository configures, so it must run where those are confined — inside
 * the sandbox, as the sandboxed child's first step. Throws
 * `WorktreeLifecycleError` when the checkout fails.
 */
export function checkoutWorktree(workspacePath: string): AgentLifecycleResult {
  const workspace = resolve(workspacePath);
  const out = git(workspace, ["checkout", "--detach"]);
  if (!out.ok) {
    throw new WorktreeLifecycleError(
      `worktree checkout failed for ${workspace}: ${out.stderr || out.stdout}`,
    );
  }
  return { changed: true, reason: "worktree checked out" };
}

export function onStop(_agentId: string, workspacePath?: string): AgentLifecycleResult {
  if (!workspacePath) {
    return { changed: false, reason: "no workspace path configured" };
  }

  const workspace = resolve(workspacePath);
  const baseRepo = resolveBaseRepo(workspace);
  if (!baseRepo) {
    return { changed: false, reason: "base repo not found or not a git repo" };
  }

  if (!existsSync(workspace)) {
    return { changed: false, reason: "workspace does not exist" };
  }

  const worktrees = parseWorktreePaths(baseRepo);
  if (!worktrees.has(workspace)) {
    return { changed: false, reason: "workspace is not a managed worktree; leaving untouched" };
  }

  const remove = git(baseRepo, ["worktree", "remove", workspace, "--force"]);
  if (!remove.ok) {
    throw new WorktreeLifecycleError(
      `worktree cleanup failed for ${_agentId} (${workspace}): ${remove.stderr || remove.stdout}`,
    );
  }

  return { changed: true, reason: "worktree removed" };
}
// ── Workspace lifecycle hooks (OPS-47 Phase 2) ─────────────────────────────

/**
 * Boot hook: query Flair for last workspace state, resume from last checkpoint.
 */
export async function onBoot(
  workspace: WorkspaceProvider,
  flair: FlairClient,
  agentId: string,
): Promise<{ lastCheckpoint?: WorkspaceState; recentEvents?: OrgEvent[] }> {
  let lastCheckpoint: WorkspaceState | undefined;
  let lastBootAt: string | undefined;

  try {
    const latest = await flair.getLatestWorkspaceState(agentId);
    if (latest) {
      slog(`[${agentId}] Last Flair checkpoint: ${latest.label ?? latest.ref} (${latest.phase ?? "unknown"} @ ${latest.timestamp})`);
      lastCheckpoint = {
        ref: latest.ref,
        label: latest.label,
        timestamp: latest.timestamp,
        provider: latest.provider,
        metadata: latest.metadata ? JSON.parse(latest.metadata) : undefined,
      };
      // Extract lastBootAt from metadata if stored
      if (latest.metadata) {
        try {
          const meta = JSON.parse(latest.metadata);
          if (meta.lastBootAt) lastBootAt = meta.lastBootAt;
        } catch {}
      }
      // Fall back to latest checkpoint timestamp
      if (!lastBootAt) lastBootAt = latest.timestamp;
    }
  } catch (err: any) {
    swarn(`[${agentId}] Flair workspace state query failed (non-fatal): ${err.message}`);
  }

  // Fetch recent OrgEvents since last boot
  let recentEvents: OrgEvent[] = [];
  try {
    const since = lastBootAt ? new Date(lastBootAt) : new Date(Date.now() - 24 * 3600_000);
    const read = await flair.getEventsSince(agentId, since);
    if (read.status === "unavailable") {
      swarn(`[${agentId}] OrgEvent catchup unavailable (${read.reason}); continuing without recent events`);
    } else {
      recentEvents = read.events;
      if (recentEvents.length > 0) {
        slog(`[${agentId}] ${recentEvents.length} org events since last boot`);
      }
    }
  } catch (err: any) {
    swarn(`[${agentId}] OrgEvent catchup failed (non-fatal): ${err.message}`);
  }

  // Checkpoint current state as boot marker, store lastBootAt
  const bootTimestamp = new Date().toISOString();
  try {
    const bootState = await workspace.checkpoint("boot");
    if (flair && agentId) {
      const record: WorkspaceStateRecord = {
        id: `${agentId}-boot-${Date.now()}`,
        agentId,
        ref: bootState.ref,
        label: bootState.label ?? "boot",
        provider: workspace.type,
        timestamp: bootState.timestamp,
        metadata: JSON.stringify({ lastBootAt: bootTimestamp }),
        phase: "boot",
        createdAt: bootState.timestamp,
      };
      await flair.writeWorkspaceState(record).catch(() => {});
    }
  } catch (err: any) {
    swarn(`[${agentId}] Boot checkpoint failed (non-fatal): ${err.message}`);
  }

  return { lastCheckpoint, recentEvents };
}

/**
 * Task start hook: snapshot workspace, write pre-task state to Flair.
 */
export async function onTaskStart(
  workspace: WorkspaceProvider,
  flair: FlairClient,
  taskId: string,
): Promise<WorkspaceState> {
  const agentId = (flair as any).agentId;
  const state = await workspace.snapshot(`pre-task-${taskId}`);

  try {
    const record: WorkspaceStateRecord = {
      id: `${agentId}-pre-${taskId}-${Date.now()}`,
      agentId,
      ref: state.ref,
      label: state.label ?? `pre-task-${taskId}`,
      provider: workspace.type,
      timestamp: state.timestamp,
      taskId,
      phase: "pre-task",
      createdAt: state.timestamp,
    };
    await flair.writeWorkspaceState(record);
  } catch (err: any) {
    swarn(`[${agentId}] Pre-task Flair write failed (non-fatal): ${err.message}`);
  }

  return state;
}

/**
 * Task complete hook: checkpoint workspace, write structured task memory to Flair.
 */
export async function onTaskComplete(
  workspace: WorkspaceProvider,
  flair: FlairClient,
  taskId: string,
  preTaskState: WorkspaceState,
  learned?: string,
): Promise<void> {
  const agentId = (flair as any).agentId;

  // Checkpoint current state
  const postState = await workspace.checkpoint(
    `task-done-${taskId}`,
    `task complete: ${taskId}`,
  );

  // Diff from pre-task state
  let changes: { files?: string[]; summary?: string } = {};
  try {
    changes = await workspace.diff(preTaskState);
  } catch {
    // non-fatal
  }

  // Write workspace state record to Flair
  try {
    const record: WorkspaceStateRecord = {
      id: `${agentId}-post-${taskId}-${Date.now()}`,
      agentId,
      ref: postState.ref,
      label: postState.label ?? `task-done-${taskId}`,
      provider: workspace.type,
      timestamp: postState.timestamp,
      taskId,
      phase: "post-task",
      summary: changes.summary,
      filesChanged: changes.files,
      createdAt: postState.timestamp,
    };
    await flair.writeWorkspaceState(record);
  } catch (err: any) {
    swarn(`[${agentId}] Post-task Flair write failed (non-fatal): ${err.message}`);
  }

  // Publish task_done OrgEvent
  try {
    await flair.publishEvent({
      kind: "task_done",
      summary: `${agentId} completed task ${taskId}`,
      detail: learned ?? undefined,
      refId: taskId,
    });
  } catch (err: any) {
    swarn(`[${agentId}] OrgEvent task_done publish failed (non-fatal): ${err.message}`);
  }

  // NOTE: Task completion data is already captured in OrgEvents above.
  // Memory is for knowledge and insights, not audit trails.
  // If agents should learn from tasks, that's MemoryReflect's job (ops-31.2).
}

/**
 * Task failure hook: checkpoint failure state, write failure record to Flair.
 */
export async function onTaskFailure(
  workspace: WorkspaceProvider,
  flair: FlairClient,
  taskId: string,
  preTaskState: WorkspaceState,
  error: string,
): Promise<void> {
  const agentId = (flair as any).agentId;

  // Checkpoint failure state
  let failState: WorkspaceState | undefined;
  try {
    failState = await workspace.checkpoint(
      `task-failed-${taskId}`,
      `WIP: failed — ${error.slice(0, 60)}`,
    );
  } catch {
    // non-fatal
  }

  // Diff from pre-task state
  let changes: { files?: string[]; summary?: string } = {};
  try {
    changes = await workspace.diff(preTaskState);
  } catch {
    // non-fatal
  }

  // Write workspace state record
  try {
    const record: WorkspaceStateRecord = {
      id: `${agentId}-fail-${taskId}-${Date.now()}`,
      agentId,
      ref: failState?.ref ?? preTaskState.ref,
      label: `task-failed-${taskId}`,
      provider: workspace.type,
      timestamp: new Date().toISOString(),
      taskId,
      phase: "failure",
      summary: `Failed: ${error.slice(0, 200)}`,
      filesChanged: changes.files,
      createdAt: new Date().toISOString(),
    };
    await flair.writeWorkspaceState(record);
  } catch (err: any) {
    swarn(`[${agentId}] Failure Flair write failed (non-fatal): ${err.message}`);
  }

  // Publish blocker OrgEvent
  try {
    await flair.publishEvent({
      kind: "blocker",
      summary: `${agentId} hit blocker on task ${taskId}: ${error.slice(0, 100)}`,
      detail: error.slice(0, 500),
      refId: taskId,
    });
  } catch (err2: any) {
    swarn(`[${agentId}] OrgEvent blocker publish failed (non-fatal): ${err2.message}`);
  }

  // NOTE: Task failure data is already captured in OrgEvents above.
  // Memory is for knowledge and insights, not audit trails.
  // If agents should learn from failures, that's MemoryReflect's job (ops-31.2).
}

// ── Topic catch-up (re-export) ─────────────────────────────────────────────

/** Re-export catchUpTopics for use by both runtimes. */
export const catchUpTopics = _catchUpTopics;
