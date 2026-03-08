/**
 * gemini-runtime.ts — Agent runtime backed by the Gemini CLI.
 * Uses Google OAuth (no API key). Same mail interface as codex/claude runtimes.
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
  snapshotSoulToDisk, bootContext, searchPastExperience,
  catchUpTopics, onBoot, onTaskStart, onTaskComplete, onTaskFailure,
} from "./agent-lifecycle.js";
import type { WorkspaceProvider } from "./workspace-provider.js";
import snooplogg from "snooplogg";

const { log: slog, warn: swarn, error: serror } = snooplogg("tps:agent:gemini");

const FLAIR_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface GeminiConfig {
  agentId: string;
  workspace: string;
  mailDir: string;
  model?: string;
  extraDirs?: string[];
  supervisorId?: string;
  taskTimeoutMs?: number;
  sessionLogPath?: string;
  flairUrl?: string;
  flairKeyPath: string;
  workspaceProvider?: WorkspaceProvider;
  pollIntervalMs?: number;
}

interface MailMessage { id: string; from: string; to: string; body: string; timestamp: string; }

function getMailPaths(mailDir: string, agentId: string) {
  const base = join(mailDir, agentId);
  const fresh = join(base, "new");
  const cur = join(base, "cur");
  const tmp = join(base, "tmp");
  const outbox = join(base, "outbox");
  for (const d of [fresh, cur, tmp, outbox]) mkdirSync(d, { recursive: true });
  return { fresh, cur, tmp, outbox };
}

function checkNewMail(mailDir: string, agentId: string): MailMessage[] {
  const { fresh, cur } = getMailPaths(mailDir, agentId);
  const files = readdirSync(fresh).filter(f => f.endsWith(".json") && !f.startsWith("."));
  const messages: MailMessage[] = [];
  for (const file of files) {
    try {
      const msg = JSON.parse(readFileSync(join(fresh, file), "utf-8")) as MailMessage;
      renameSync(join(fresh, file), join(cur, file));
      messages.push(msg);
    } catch {}
  }
  return messages;
}

function sendMail(mailDir: string, from: string, to: string, body: string): void {
  const { fresh, tmp } = getMailPaths(mailDir, to);
  const id = randomUUID();
  const ts = new Date().toISOString();
  const filename = `${ts.replace(/[:.]/g, "-")}-${id}.json`;
  const msg: MailMessage = { id, from, to, body, timestamp: ts };
  writeFileSync(join(tmp, filename), JSON.stringify(msg, null, 2));
  renameSync(join(tmp, filename), join(fresh, filename));
}

function getFallbackSoulPath(agentId: string): string {
  return join(homedir(), ".tps", "agents", agentId, "fallback", "SOUL.md");
}

/** Returns { systemPrompt, userTask } — kept separate so gemini gets
 *  system context via stdin and the task body via -p (avoids prompt echo). */
async function buildPrompt(message: MailMessage, config: GeminiConfig): Promise<{ systemPrompt: string; userTask: string }> {
  let systemPrompt = "";
  try {
    const flair = new FlairClient({
      baseUrl: config.flairUrl,
      agentId: config.agentId,
      keyPath: config.flairKeyPath,
    });
    const bootResult = await Promise.race([
      bootContext(flair, config.agentId, message.body.slice(0, 100), config.workspace, { supervisorId: config.supervisorId }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("boot timeout")), 10_000)),
    ]);
    systemPrompt = bootResult.systemPrompt;
    const experience = await Promise.race([
      searchPastExperience(flair, message.body, config.workspace),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (experience) systemPrompt += "\n\n" + experience;
  } catch (err: unknown) {
    swarn(`Flair boot failed, using disk fallback: ${(err as Error).message}`);
    const soulPath = getFallbackSoulPath(config.agentId);
    if (existsSync(soulPath)) {
      systemPrompt = readFileSync(soulPath, "utf-8");
    } else {
      systemPrompt = `You are ${config.agentId}. Respond helpfully.`;
    }
  }
  const userTask = `[Mail from: ${message.from}]\n${message.body}`;
  return { systemPrompt, userTask };
}

async function runGemini(message: MailMessage, config: GeminiConfig, taskTimeoutMs: number): Promise<string> {
  const { systemPrompt, userTask } = await buildPrompt(message, config);
  const model = config.model ?? "gemini-2.5-pro";
  const logPath = config.sessionLogPath ?? join(homedir(), ".tps", "agents", config.agentId, "session.log");
  appendFileSync(logPath, `\n${"=".repeat(60)}\n[${new Date().toISOString()}] Task from ${message.from} (gemini)\n${"=".repeat(60)}\n`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  // Gemini: pass prompt via stdin (avoids arg length limits with long system prompts)
  const args = ["-y", "--model", model, "-p", userTask, "-e", ""];

  return new Promise((resolve, reject) => {
    const proc = spawn("gemini", args, { cwd: config.workspace, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TPS_AGENT_ID: config.agentId } });
    proc.stdin.write(systemPrompt);
    proc.stdin.end();
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => { chunks.push(c); logStream.write(c); });
    proc.stderr.on("data", (c: Buffer) => logStream.write(c));
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`timeout after ${taskTimeoutMs}ms`)); }, taskTimeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer); logStream.end();
      const out = Buffer.concat(chunks).toString("utf-8").trim();
      resolve(out || `(exit ${code})`);
    });
    proc.on("error", (err) => { clearTimeout(timer); logStream.end(); reject(err); });
  });
}

export async function runGeminiRuntime(config: GeminiConfig): Promise<void> {
  const { agentId, mailDir, workspaceProvider, flairUrl, flairKeyPath, pollIntervalMs = 5000, taskTimeoutMs = 30 * 60 * 1000 } = config;
  slog(`Gemini runtime started. Polling ${mailDir}/${agentId}/new`);

  const flair = new FlairClient({ baseUrl: flairUrl, agentId, keyPath: flairKeyPath });

  // Boot lifecycle — skip Flair snapshot on first boot (agent may not be registered)
  slog("Boot: skipping Flair snapshot (use disk fallback)");

  let lastSnapshot = Date.now();

  while (true) {
    for (const msg of checkNewMail(mailDir, agentId)) {
      slog(`Processing mail from ${msg.from}: ${msg.body.slice(0, 60)}...`);
      try {
        let preState: import("./workspace-provider.js").WorkspaceState | undefined;
        if (workspaceProvider) preState = await onTaskStart(workspaceProvider, flair, msg.id).catch(() => undefined);
        const result = await runGemini(msg, config, taskTimeoutMs);
        slog(`Task complete. Result: ${result.length} chars`);
        sendMail(mailDir, agentId, msg.from, result);
        if (workspaceProvider && preState) await onTaskComplete(workspaceProvider, flair, msg.id, preState, result).catch(() => {});
      } catch (err: unknown) {
        serror(`Task failed: ${(err as Error).message}`);
        sendMail(mailDir, agentId, msg.from, `Error: ${(err as Error).message}`);
        if (workspaceProvider) {
          const preState = await onTaskStart(workspaceProvider, flair, msg.id).catch(() => undefined);
          if (preState) await onTaskFailure(workspaceProvider, flair, msg.id, preState, (err as Error).message).catch(() => {});
        }
      }
    }
    if (Date.now() - lastSnapshot > FLAIR_SNAPSHOT_INTERVAL_MS) {
      snapshotSoulToDisk(flair, agentId).catch(() => {});
      lastSnapshot = Date.now();
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}
