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
import { join } from "node:path";
import { homedir } from "node:os";
import { FlairClient } from "./flair-client.js";
import { catchUpTopics as _catchUpTopics } from "./mail-topics.js";
import type { WorkspaceProvider } from "./workspace-provider.js";

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
        console.warn(`[${agentId}] ⚠️  Flair offline — using stale disk fallback (${fallbackPath})`);
      }
    }

    if (identitySource !== "disk") {
      const workspaceSoul = join(workspace, "SOUL.md");
      if (existsSync(workspaceSoul)) {
        const content = readFileSync(workspaceSoul, "utf-8").trim();
        if (content) {
          parts.push(content.slice(0, 2000));
          identitySource = "disk";
          console.warn(`[${agentId}] ⚠️  Flair offline — using workspace SOUL.md fallback`);
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

Always commit your work before mailing ${supervisor}:
  git add -A && git commit --author="${agentId} <${agentId}@tps.dev>" -m "feat: ..."
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
): Promise<string> {
  try {
    const flairOnline = await flair.ping();
    if (!flairOnline) return "";

    const searchResults = await flair.search(taskDescription.slice(0, 200), 5);
    if (searchResults.length === 0) return "";

    const experienceBlock = searchResults
      .map(r => `- ${r.content?.slice(0, 200) ?? r.id}`)
      .join("\n");
    return `## Relevant Past Experience\n${experienceBlock}`;
  } catch (err: any) {
    console.warn("[flair] SearchMemories failed (non-fatal):", err.message);
    return "";
  }
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
    console.warn(`[${agentId}] Flair ${type} memory write failed (non-fatal):`, err.message);
  }
}

// ── Topic catch-up (re-export) ─────────────────────────────────────────────

/** Re-export catchUpTopics for use by both runtimes. */
export const catchUpTopics = _catchUpTopics;
