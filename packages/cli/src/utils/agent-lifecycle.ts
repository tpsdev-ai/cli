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

import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
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
  /** Git metadata for a worktree launch with deferred checkout. */
  gitDir?: string;
  /**
   * Absolute path of the worktree's git common directory — the base
   * repository's metadata that `gitDir`'s `commondir` file points to. Present
   * in the same case as `gitDir`.
   */
  gitCommonDir?: string;
  baseWorkingTree?: string;
}

/**
 * A worktree setup, checkout or cleanup operation failed (cli#516). Named so a
 * caller can tell a worktree failure from any other error and report it as one;
 * the message names the operation that failed.
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
  // Disable inherited GIT_* variables and system/global config entry points;
  // local config includes remain enabled.
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

type RepoProbe =
  | { kind: "repo"; path: string }
  | { kind: "not-a-repo" }
  | { kind: "error"; detail: string };

function probeRepo(path: string): RepoProbe {
  try {
    let candidate;
    try {
      candidate = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-a-repo" };
      throw err;
    }
    path = realpathSync(path);
    candidate = lstatSync(path);
    if (!candidate.isDirectory()) {
      return { kind: "error", detail: "base path is not a plain directory" };
    }
    readdirSync(path);
    const markerPath = join(path, ".git");
    let marker;
    try {
      marker = lstatSync(markerPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-a-repo" };
      throw err;
    }
    if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
      return { kind: "error", detail: "git marker is not a regular file or directory" };
    }
    if (marker.isDirectory()) readdirSync(markerPath);
    else readFileSync(markerPath);
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  }
  const out = git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (out.ok && out.stdout === "true") return { kind: "repo", path };
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
    if (probe.kind === "repo") return probe.path;
    if (probe.kind === "error") {
      throw new WorktreeLifecycleError(
        `git probe failed for the base repository ${candidate}: ${probe.detail}`,
      );
    }
  }
  return null;
}

export type WorktreeLaunchBinding =
  | { kind: "none" }
  | { kind: "unregistered"; baseWorkingTree: string }
  | { kind: "registered"; gitDir: string; gitCommonDir: string; baseWorkingTree: string };

/**
 * Classify a launch workspace against the trusted base repository.
 *
 * Registry ownership is decided from the trusted base's registry alone: the
 * recorded `.git` path is compared to the workspace's `.git` path, so a
 * registered entry is found even when its marker is missing, is a directory,
 * or its workspace directory is absent. A registered workspace must then
 * carry a regular `.git` file; anything else is refused before any grant is
 * computed. An unregistered regular `.git` file is a worktree we do not
 * manage: it gets no metadata grants, but the caller still needs the trusted
 * base so grants can be checked against it.
 */
export function worktreeLaunchBinding(workspacePath: string): WorktreeLaunchBinding {
  const workspace = resolve(workspacePath);
  try {
    const workspaceStat = lstatSync(workspace);
    if (!workspaceStat.isDirectory()) {
      throw new WorktreeLifecycleError(`worktree marker probe failed: workspace is not a directory: ${workspace}`);
    }
  } catch (err) {
    if (err instanceof WorktreeLifecycleError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The workspace directory is absent, but a registered worktree keeps its
      // ownership in the trusted base's registry. Refuse it before any grant is
      // computed; an absent unregistered path keeps the caller's cwd policy.
      const trustedBase = resolveBaseRepo(workspace);
      if (
        trustedBase &&
        trustedBaseRegistersWorkspace(workspace, resolvableWorkspacePath(workspace), trustedBase)
      ) {
        throw new WorktreeLifecycleError(
          `worktree workspace is missing for a registered worktree: ${workspace}`,
        );
      }
      return { kind: "none" };
    }
    throw new WorktreeLifecycleError(`worktree marker probe failed: ${(err as Error).message}`);
  }
  const markerPath = join(workspace, ".git");
  let marker: ReturnType<typeof lstatSync> | undefined;
  try {
    marker = lstatSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WorktreeLifecycleError(`worktree marker probe failed: ${(err as Error).message}`);
    }
  }
  // A symlink marker is refused wherever it appears, before any base lookup.
  if (marker?.isSymbolicLink()) throw new WorktreeLifecycleError(`worktree git marker is a symlink: ${workspace}`);
  const trustedBase = resolveBaseRepo(workspace);
  // No tps base repository: not a tps-managed worktree, so no metadata grants.
  if (!trustedBase) return { kind: "none" };
  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = realpathSync(workspace);
  } catch (err) {
    throw new WorktreeLifecycleError(`worktree path could not be resolved for ${workspace}: ${(err as Error).message}`);
  }
  if (resolvedWorkspace === trustedBase) return { kind: "none" };
  const registered = trustedBaseRegistersWorkspace(workspace, resolvedWorkspace, trustedBase);
  if (!marker) {
    if (registered) {
      throw new WorktreeLifecycleError(`worktree git marker is missing for a registered worktree: ${workspace}`);
    }
    return { kind: "none" };
  }
  if (registered) {
    if (!marker.isFile()) {
      throw new WorktreeLifecycleError(`worktree git marker is not a regular file for a registered worktree: ${workspace}`);
    }
    return { kind: "registered", ...worktreeGitMetadata(workspace, trustedBase) };
  }
  // Only a regular `.git` marker makes this an unregistered worktree; a plain
  // directory or an ordinary repository keeps the caller's cwd policy.
  if (!marker.isFile()) return { kind: "none" };
  return { kind: "unregistered", baseWorkingTree: trustedBase };
}

export function worktreeLaunchGit(workspacePath: string): { gitDir: string; gitCommonDir: string; baseWorkingTree: string } | undefined {
  const binding = worktreeLaunchBinding(workspacePath);
  if (binding.kind !== "registered") return undefined;
  return { gitDir: binding.gitDir, gitCommonDir: binding.gitCommonDir, baseWorkingTree: binding.baseWorkingTree };
}

/** Canonical form of a workspace path that may not exist yet: resolve the
 *  workspace when present, otherwise its parent directory. */
function resolvableWorkspacePath(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch {
    try {
      return join(realpathSync(dirname(workspace)), basename(workspace));
    } catch {
      return resolve(workspace);
    }
  }
}

/** Whether `baseRepo`'s worktree registry lists `workspace`'s .git path. The
 *  registry lives in the trusted base, not in the workspace, and the recorded
 *  path is compared without resolving the marker itself. */
function trustedBaseRegistersWorkspace(workspace: string, resolvedWorkspace: string, baseRepo: string): boolean {
  const common = git(baseRepo, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.stdout) {
    throw new WorktreeLifecycleError(`trusted base common git directory could not be resolved for ${baseRepo}`);
  }
  let commonDir: string;
  try {
    commonDir = realpathSync(resolve(baseRepo, common.stdout));
  } catch (err) {
    throw new WorktreeLifecycleError(
      `trusted base common git directory could not be resolved for ${baseRepo}: ${(err as Error).message}`,
    );
  }
  const registry = join(commonDir, "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(registry);
  } catch (err) {
    // No registry directory means the base has no linked worktrees.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new WorktreeLifecycleError(`worktree registry could not be read for ${baseRepo}: ${(err as Error).message}`);
  }
  const markerPaths = new Set([
    resolve(join(workspace, ".git")),
    resolve(join(resolvedWorkspace, ".git")),
  ]);
  return entries.some((entry) => {
    let recorded: string;
    try {
      recorded = readFileSync(join(registry, entry, "gitdir"), "utf-8").trim();
    } catch (err) {
      throw new WorktreeLifecycleError(
        `worktree registry entry could not be read for ${baseRepo}: ${(err as Error).message}`,
      );
    }
    return recorded.length > 0 && markerPaths.has(resolve(recorded));
  });
}

/**
 * Create the agent's worktree when a base repository exists and the workspace
 * is absent. An existing worktree, an existing ordinary workspace, the base
 * repository itself, and a workspace with no base repository are left
 * untouched and reported as changed:false.
 *
 * With `deferCheckout: true`, setup disables hooks and fsmonitor and skips checkout.
 *
 * Throws `WorktreeLifecycleError` when repository inspection or a git operation fails.
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
    return { changed: false, reason: "worktree already exists", ...(opts.deferCheckout ? worktreeGitMetadata(workspace, baseRepo) : {}) };
  }

  if (existsSync(workspace)) {
    return { changed: false, reason: "workspace exists but is not a worktree; leaving untouched" };
  }

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

  const rollback = () => git(baseRepo, ["worktree", "remove", "--force", workspace]);
  try {
    return {
      changed: true,
      reason: defer ? "worktree created; checkout deferred" : "worktree created",
      ...(defer ? worktreeGitMetadata(workspace, baseRepo) : {}),
    };
  } catch (err) {
    const removed = rollback();
    if (!removed.ok) {
      throw new WorktreeLifecycleError(`${(err as Error).message}; worktree cleanup failed: ${removed.stderr || removed.stdout}`);
    }
    throw err;
  }
}

function worktreeGitMetadata(workspace: string, baseRepo: string): { gitDir: string; gitCommonDir: string; baseWorkingTree: string } {
  const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok || !gitDir.stdout) {
    throw new WorktreeLifecycleError(
      `worktree git directory could not be resolved for ${workspace}: ${gitDir.stderr || gitDir.stdout || "git rev-parse produced no output"}`,
    );
  }
  try {
    const base = parseWorktreePaths(workspace).values().next().value;
    const trustedCommon = git(baseRepo, ["rev-parse", "--git-common-dir"]);
    if (!trustedCommon.ok || !trustedCommon.stdout) {
      throw new Error("trusted base common git directory could not be resolved");
    }
    const gitCommonDir = realpathSync(resolve(baseRepo, trustedCommon.stdout));
    if (!base || realpathSync(base) !== baseRepo ||
        realpathSync(worktreeCommonDir(gitDir.stdout)) !== gitCommonDir) {
      throw new Error("worktree metadata does not belong to the trusted base");
    }
    const registry = join(gitCommonDir, "worktrees");
    const markerPath = realpathSync(join(workspace, ".git"));
    const trustedGitDir = readdirSync(registry)
      .map((entry) => join(registry, entry))
      .find((entry) => {
        try {
          return realpathSync(readFileSync(join(entry, "gitdir"), "utf-8").trim()) === markerPath;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw err;
        }
      });
    if (!trustedGitDir || realpathSync(gitDir.stdout) !== realpathSync(trustedGitDir)) {
      throw new Error("worktree git directory does not belong to the trusted base");
    }
    return { gitDir: realpathSync(trustedGitDir), gitCommonDir, baseWorkingTree: baseRepo };
  } catch (err) {
    throw new WorktreeLifecycleError(`worktree metadata binding failed for ${workspace}: ${(err as Error).message}`);
  }
}

/**
 * Resolve a linked worktree's common git directory from its git directory
 * (cli#516). The git directory holds a `commondir` file naming the base
 * repository's metadata directory (objects, refs, config) relative to it.
 */
export function worktreeCommonDir(gitDir: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
  } catch (err) {
    throw new WorktreeLifecycleError(
      `worktree common git directory could not be read for ${gitDir}: ${(err as Error).message}`,
    );
  }
  if (!raw) throw new WorktreeLifecycleError(`the commondir file in ${gitDir} is empty`);
  return resolve(gitDir, raw);
}

/**
 * Populate a worktree the parent created with `--no-checkout` (cli#516). This
 * checkout may run repository-configured filters and hooks, so the caller must
 * run it inside the sandbox. Throws `WorktreeLifecycleError` on failure.
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

/** True when `path` exists; only ENOENT counts as absent (cli#516). Any other
 *  lstat failure — e.g. EACCES on a parent, a non-directory in the path — is
 *  thrown, so a failed probe is never read as "nothing there". */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
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

  let workspaceExists: boolean;
  try {
    workspaceExists = pathExists(workspace);
  } catch (err) {
    throw new WorktreeLifecycleError(
      `workspace probe failed for ${workspace}: ${(err as Error).message}`,
    );
  }
  if (!workspaceExists) {
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
