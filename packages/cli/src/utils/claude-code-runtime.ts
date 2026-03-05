/**
 * claude-code-runtime.ts
 *
 * Alternative agent runtime that delegates to the Claude Code CLI instead of
 * making direct LLM API calls. Handles OAuth transparently through the user's
 * existing `claude` authentication.
 *
 * Architecture:
 *   1. Check TPS mail inbox for new messages
 *   2. For each message, build system prompt from Flair (with disk fallback)
 *   3. Spawn `claude --print` with the message as prompt
 *   4. Claude Code runs its own tool loop (Bash, Read, Write, Edit)
 *   5. On completion, send reply via TPS mail
 *   6. Repeat (background: snapshot Flair soul to disk daily)
 *
 * System prompt source priority:
 *   1. Flair (primary) — soul + task-relevant memories
 *   2. Disk fallback (~/.tps/agents/<id>/fallback/SOUL.md) with ⚠️ warning
 *   3. Hard fail — mails supervisor if neither is available
 *
 * This runtime does NOT use:
 *   - TPS LLM proxy
 *   - TPS tool registry
 *   - TPS EventLoop
 *
 * It DOES use:
 *   - TPS mail (inbox/outbox)
 *   - Flair (soul + memories)
 *   - Disk fallback (daily snapshot from Flair)
 *   - WorkspaceProvider (OPS-47) for workspace lifecycle
 */

import { spawn } from "node:child_process";
import {
  readFileSync, existsSync, mkdirSync, readdirSync,
  renameSync, writeFileSync, appendFileSync, createWriteStream,
} from "node:fs";
import { join } from "node:path";
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
import type { WorkspaceProvider } from "./workspace-provider.js";

/** How often to snapshot Flair soul to disk (ms) */
const FLAIR_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export interface ClaudeCodeConfig {
  agentId: string;
  workspace: string;
  mailDir: string;
  model?: string;
  /** Allowed tools for Claude Code (default: Bash Read Write Edit) */
  allowedTools?: string[];
  /** Additional directories Claude Code can access */
  extraDirs?: string[];
  /** Agent to notify when done (defaults to "host") */
  supervisorId?: string;
  /** Max ms to wait for claude to finish a task (default: 30 minutes) */
  taskTimeoutMs?: number;
  /** Path to session log file (default: ~/.tps/agents/<id>/session.log) */
  sessionLogPath?: string;
  /** Flair base URL (default: http://127.0.0.1:9926) */
  flairUrl?: string;
  /** Path to Ed25519 private key for Flair auth (default: ~/.tps/identity/<agentId>.key) */
  flairKeyPath?: string;
  /** Optional workspace provider for lifecycle management (OPS-47) */
  workspaceProvider?: WorkspaceProvider;
}

interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

// ─── Mail helpers ───────────────────────────────────────────────────────────

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

// ─── System prompt (delegates to agent-lifecycle) ────────────────────────────

function getFallbackSoulPath(agentId: string): string {
  return join(homedir(), ".tps", "agents", agentId, "fallback", "SOUL.md");
}

async function buildSystemPrompt(
  message: MailMessage,
  config: ClaudeCodeConfig,
): Promise<string> {
  const { agentId, workspace, allowedTools, supervisorId, flairUrl, flairKeyPath } = config;

  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });

  const { systemPrompt, identitySource } = await bootContext(
    flair, agentId, message.body.slice(0, 100), workspace,
    { allowedTools, supervisorId },
  );

  // Append past experience search
  const experience = await searchPastExperience(flair, message.body);
  if (experience) {
    return systemPrompt + "\n\n" + experience;
  }

  return systemPrompt;
}

// ─── Claude invocation ───────────────────────────────────────────────────────

async function runClaudeCode(
  message: MailMessage,
  config: ClaudeCodeConfig,
  taskTimeoutMs: number,
): Promise<string> {
  const systemPrompt = await buildSystemPrompt(message, config);
  const model = config.model ?? "claude-sonnet-4-6";
  const allowedTools = (config.allowedTools ?? ["Bash", "Read", "Write", "Edit"]).join(",");

  const prompt = [
    `[Mail from: ${message.from}]`,
    message.body,
  ].join("\n\n");

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--allowedTools", allowedTools,
    "--add-dir", config.workspace,
    "--no-session-persistence",
  ];

  for (const dir of config.extraDirs ?? []) {
    args.push("--add-dir", dir);
  }

  // Session log — append with task header
  const logPath = config.sessionLogPath ?? join(homedir(), ".tps", "agents", config.agentId, "session.log");
  const promptSrc = systemPrompt.includes("Flair (live)") ? "flair" : "disk-fallback";
  const logHeader = `\n${"=".repeat(60)}\n[${new Date().toISOString()}] Task from ${message.from} | prompt_src: ${promptSrc}\n${"=".repeat(60)}\n`;
  appendFileSync(logPath, logHeader, "utf-8");
  const logStream = createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: config.workspace,
      env: { ...process.env },
    });

    // Send prompt via stdin (required for stream-json)
    proc.stdin.write(prompt);
    proc.stdin.end();

    let resultText = "";
    let turnCount = 0;
    let stderr = "";

    // Parse NDJSON stream line-by-line — real-time visibility
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      logStream.write(d); // raw to session.log for tail -f
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, any>;
          if (event.type === "assistant") {
            // Log tool calls for visibility
            const toolUses = (event.message?.content ?? []).filter((c: any) => c.type === "tool_use");
            for (const tu of toolUses) {
              turnCount++;
              const args = typeof tu.input === "object" ? JSON.stringify(tu.input).slice(0, 80) : String(tu.input ?? "");
              console.log(`[${config.agentId}] turn ${turnCount}: ${tu.name}(${args})`);
            }
          } else if (event.type === "result") {
            // Final event — extract result
            if (event.is_error || event.subtype === "error") {
              reject(new Error(`claude error: ${event.result ?? "unknown"}`));
            } else {
              resultText = event.result ?? "(no output)";
            }
          }
        } catch {
          // non-JSON line — ignore
        }
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      logStream.write(d);
    });

    const _timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, taskTimeoutMs);

    proc.on("close", (code) => {
      clearTimeout(_timeout);
      logStream.end();
      if (code !== 0 && !resultText) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      if (resultText) {
        resolve(resultText);
      } else {
        reject(new Error(`claude exited ${code} with no result`));
      }
    });

    proc.on("error", reject);
  });
}

// ─── Main loop ───────────────────────────────────────────────────────────────

export async function runClaudeCodeRuntime(config: ClaudeCodeConfig): Promise<void> {
  const { agentId, mailDir, workspace, flairUrl, flairKeyPath, workspaceProvider } = config;

  // Write PID file
  const pidPath = join(workspace, ".tps-agent.pid");
  writeFileSync(pidPath, `${process.pid}\n`, "utf-8");

  console.log(`[${agentId}] Claude Code runtime started. Polling ${mailDir}/${agentId}/new`);

  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });

  // Initial Flair health check + snapshot
  const flairOnline = await flair.ping();
  if (flairOnline) {
    console.log(`[${agentId}] Flair online — snapshotting soul to disk`);
    await snapshotSoulToDisk(flair, agentId);
  } else {
    const fallback = getFallbackSoulPath(agentId);
    console.warn(`[${agentId}] ⚠️  Flair offline at startup. Fallback: ${existsSync(fallback) ? fallback : "NONE — will fail on first task"}`);
  }

  // Boot: catch up on any topic messages missed while offline
  try {
    const caught = catchUpTopics(agentId);
    if (caught > 0) {
      console.log(`[${agentId}] Caught up ${caught} missed topic message(s) on boot`);
    }
  } catch (err: any) {
    console.warn(`[${agentId}] Topic catch-up failed at boot: ${err.message}`);
  }

  // Boot: workspace lifecycle — query Flair for last state, checkpoint (OPS-47 Phase 2)
  if (workspaceProvider) {
    try {
      const { lastCheckpoint } = await onBoot(workspaceProvider, flair, agentId);
      if (lastCheckpoint) {
        console.log(`[${agentId}] Resumed from last checkpoint: ${lastCheckpoint.label ?? lastCheckpoint.ref}`);
      }
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

  let lastSnapshot = Date.now();
  const POLL_MS = 5000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Background: periodic Flair → disk snapshot
    if (Date.now() - lastSnapshot > FLAIR_SNAPSHOT_INTERVAL_MS) {
      if (await flair.ping()) {
        await snapshotSoulToDisk(flair, agentId);
        lastSnapshot = Date.now();
        console.log(`[${agentId}] Flair soul snapshot refreshed`);
      }
    }

    const messages = checkNewMail(mailDir, agentId);

    for (const msg of messages) {
      console.log(`[${agentId}] Processing mail from ${msg.from}: ${msg.body.slice(0, 60)}...`);

      // Task start: snapshot workspace via lifecycle hook (OPS-47 Phase 2)
      const taskId = msg.id;
      let preTaskState;
      if (workspaceProvider) {
        try {
          preTaskState = await onTaskStart(workspaceProvider, flair, taskId);
        } catch (err: any) {
          console.warn(`[${agentId}] Pre-task lifecycle failed: ${err.message}`);
        }
      }

      try {
        const result = await runClaudeCode(msg, config, config.taskTimeoutMs ?? 30 * 60 * 1000);
        console.log(`[${agentId}] Task complete. Result length: ${result.length}`);
        const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
        sendMail(mailDir, agentId, msg.from, `Task complete:\n\n${summary}`);

        // Task complete: checkpoint + structured memory via lifecycle hook (OPS-47 Phase 2)
        if (workspaceProvider && preTaskState) {
          try {
            await onTaskComplete(workspaceProvider, flair, taskId, preTaskState);
          } catch (err: any) {
            console.warn(`[${agentId}] Post-task lifecycle failed: ${err.message}`);
          }
        } else {
          // Fallback: write task memory directly if no workspace provider
          await writeTaskMemory(flair, agentId, "completion", {
            task: msg.body,
            summary,
          });
        }
      } catch (err: any) {
        // Hard fail: no system prompt available → notify supervisor
        if (err.message.startsWith("No system prompt available")) {
          console.error(`[${agentId}] FATAL: ${err.message}`);
          sendMail(mailDir, agentId, config.supervisorId ?? msg.from,
            `Agent ${agentId} cannot start task: ${err.message}`);
        } else {
          console.error(`[${agentId}] Task failed:`, err.message);
          sendMail(mailDir, agentId, msg.from, `Task failed: ${err.message}`);

          // Task failure: checkpoint + failure record via lifecycle hook (OPS-47 Phase 2)
          if (workspaceProvider && preTaskState) {
            try {
              await onTaskFailure(workspaceProvider, flair, taskId, preTaskState, err.message);
            } catch (cpErr: any) {
              console.warn(`[${agentId}] Failure lifecycle failed: ${cpErr.message}`);
            }
          } else {
            await writeTaskMemory(flair, agentId, "failure", {
              task: msg.body,
              error: err.message,
            });
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
