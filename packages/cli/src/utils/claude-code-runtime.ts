/**
 * claude-code-runtime.ts
 *
 * Alternative agent runtime that delegates to the Claude Code CLI instead of
 * making direct LLM API calls. Handles OAuth transparently through the user's
 * existing `claude` authentication.
 *
 * Architecture:
 *   1. Check TPS mail inbox for new messages
 *   2. For each message, spawn `claude --print` with the message as prompt
 *   3. Claude Code runs its own tool loop (Bash, Read, Write, Edit)
 *   4. On completion, send reply via TPS mail
 *   5. Repeat
 *
 * This runtime does NOT use:
 *   - TPS LLM proxy
 *   - TPS tool registry
 *   - TPS EventLoop
 *
 * It DOES use:
 *   - TPS mail (inbox/outbox)
 *   - Workspace files (SOUL.md, AGENTS.md loaded as --system-prompt)
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ClaudeCodeConfig {
  agentId: string;
  workspace: string;
  mailDir: string;
  model?: string;
  /** Allowed tools for Claude Code (default: Bash Read Write Edit) */
  allowedTools?: string[];
  /** Additional directories Claude Code can access */
  extraDirs?: string[];
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
  // Write to recipient's new/ inbox
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

function buildSystemPrompt(workspace: string, config: ClaudeCodeConfig): string {
  const parts: string[] = [];

  // Load workspace orientation files (limit SOUL.md to keep prompt short)
  const soul = join(workspace, "SOUL.md");
  if (existsSync(soul)) {
    // Truncate to first 2000 chars to avoid huge prompts
    const content = readFileSync(soul, "utf-8").trim();
    parts.push(content.slice(0, 2000));
  }

  // Runtime-specific instructions
  parts.push(`
## Runtime Context

You are running as agent \`${config.agentId}\` via Claude Code CLI.
Your workspace: ${workspace}
Tools available: ${(config.allowedTools ?? ["Bash", "Read", "Write", "Edit"]).join(", ")}

When you finish a task, use Bash to send mail:
  cd ${workspace} && bun run /Users/squeued/ops/tps/packages/cli/bin/tps.ts mail send rockit "done: <summary>"

Always commit your work before mailing rockit:
  git add -A && git commit --author="Ember <ember@tps.dev>" -m "feat: ..."
`.trim());

  return parts.join("\n\n");
}

async function runClaudeCode(
  message: MailMessage,
  config: ClaudeCodeConfig,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(config.workspace, config);
  const model = config.model ?? "claude-sonnet-4-6";
  const allowedTools = (config.allowedTools ?? ["Bash", "Read", "Write", "Edit"]).join(",");

  const prompt = [
    `[Mail from: ${message.from}]`,
    message.body,
  ].join("\n\n");

  const args = [
    "--print",
    "--output-format", "json",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--allowedTools", allowedTools,
    "--add-dir", config.workspace,
    "--no-session-persistence",
    prompt,
  ];

  // Add extra dirs
  for (const dir of config.extraDirs ?? []) {
    args.push("--add-dir", dir);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: config.workspace,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const _timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 10 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(_timeout);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as { result?: string; is_error?: boolean };
        if (result.is_error) {
          reject(new Error(`claude error: ${result.result}`));
        } else {
          resolve(result.result ?? "(no output)");
        }
      } catch {
        resolve(stdout.trim() || "(no output)");
      }
    });

    proc.on("error", reject);
  });
}

export async function runClaudeCodeRuntime(config: ClaudeCodeConfig): Promise<void> {
  const { agentId, mailDir, workspace } = config;

  // Write PID file
  const pidPath = join(workspace, ".tps-agent.pid");
  writeFileSync(pidPath, `${process.pid}\n`, "utf-8");

  console.log(`[${agentId}] Claude Code runtime started. Polling ${mailDir}/${agentId}/new`);

  const POLL_MS = 5000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const messages = checkNewMail(mailDir, agentId);

    for (const msg of messages) {
      console.log(`[${agentId}] Processing mail from ${msg.from}: ${msg.body.slice(0, 60)}...`);

      try {
        const result = await runClaudeCode(msg, config);
        console.log(`[${agentId}] Task complete. Result length: ${result.length}`);
        // Send summary back to sender
        const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
        sendMail(mailDir, agentId, msg.from, `Task complete:\n\n${summary}`);
      } catch (err: any) {
        console.error(`[${agentId}] Task failed:`, err.message);
        sendMail(mailDir, agentId, msg.from, `Task failed: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
