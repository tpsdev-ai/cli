/**
 * codex-runtime.ts — Agent runtime backed by the Codex CLI (codex exec --json).
 * Uses ChatGPT OAuth credentials; no OpenAI API key required.
 * Same interface as claude-code-runtime.ts.
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
import {
  refreshOpenAIToken,
  type StoredCredentials,
} from "../commands/auth.js";
import type { WorkspaceProvider } from "./workspace-provider.js";

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
  flairKeyPath?: string;
  workspaceProvider?: WorkspaceProvider;
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
    const proc = spawn("codex", args, { cwd: config.workspace, env: process.env });
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

export async function runCodexRuntime(config: CodexRuntimeConfig): Promise<void> {
  const { agentId, mailDir, workspace, flairUrl, flairKeyPath, workspaceProvider } = config;
  writeFileSync(join(workspace, ".tps-agent.pid"), `${process.pid}\n`, "utf-8");
  console.log(`[${agentId}] Codex runtime started. Polling ${mailDir}/${agentId}/new`);

  await ensureFreshOpenAIToken(agentId);

  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });
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

  let lastSnapshot = Date.now();
  let lastTokenRefresh = Date.now();
  const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // check every 30min
  while (true) {
    if (Date.now() - lastTokenRefresh > TOKEN_REFRESH_INTERVAL_MS) {
      await ensureFreshOpenAIToken(agentId);
      lastTokenRefresh = Date.now();
    }
    if (Date.now() - lastSnapshot > FLAIR_SNAPSHOT_INTERVAL_MS && await flair.ping()) {
      await snapshotSoulToDisk(flair, agentId);
      lastSnapshot = Date.now();
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
        sendMail(mailDir, agentId, msg.from, `Task complete:\n\n${summary}`);
        if (workspaceProvider && preTaskState) {
          try { await onTaskComplete(workspaceProvider, flair, msg.id, preTaskState); } catch (err: any) {
            console.warn(`[${agentId}] Post-task lifecycle failed: ${err.message}`);
          }
        } else {
          await writeTaskMemory(flair, agentId, "completion", { task: msg.body, summary });
        }
      } catch (err: any) {
        console.error(`[${agentId}] Task failed:`, err.message);
        sendMail(mailDir, agentId, msg.from, `Task failed: ${err.message}`);
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
