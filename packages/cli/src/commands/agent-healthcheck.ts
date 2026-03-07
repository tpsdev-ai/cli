/**
 * agent-healthcheck.ts — `tps agent healthcheck <agentId>`
 *
 * Diagnoses why an agent might not be responding:
 *   - Flair key readable
 *   - Flair reachable + authenticated
 *   - Mail dir writable
 *   - OpenAI token valid (if present)
 *   - Agent process alive (via PID file)
 *   - Task cursor last-seen timestamp
 */

import { existsSync, readFileSync, accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFlairClient } from "../utils/flair-client.js";

export interface HealthcheckOpts {
  agentId?: string;
  flairUrl?: string;
  keyPath?: string;
  mailDir?: string;
  workspace?: string;
  json?: boolean;
  noColor?: boolean;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function esc(code: number, t: string, nc: boolean) { return nc ? t : `\x1b[${code}m${t}\x1b[0m`; }
const green = (t: string, nc: boolean) => esc(32, t, nc);
const red   = (t: string, nc: boolean) => esc(31, t, nc);
const dim   = (t: string, nc: boolean) => esc(2,  t, nc);
const bold  = (t: string, nc: boolean) => esc(1,  t, nc);

function relTime(iso: string | undefined | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function checkKey(keyPath: string): Check {
  const name = "Flair key";
  if (!existsSync(keyPath)) return { name, pass: false, detail: `not found at ${keyPath}` };
  try {
    accessSync(keyPath, constants.R_OK);
    const size = statSync(keyPath).size;
    if (size < 32) return { name, pass: false, detail: `file too small (${size} bytes)` };
    return { name, pass: true, detail: keyPath };
  } catch {
    return { name, pass: false, detail: `not readable: ${keyPath}` };
  }
}

function checkMailDir(mailDir: string, agentId: string): Check {
  const name = "Mail dir";
  const inbox = join(mailDir, agentId, "new");
  if (!existsSync(inbox)) return { name, pass: false, detail: `inbox missing: ${inbox}` };
  try {
    accessSync(inbox, constants.W_OK);
    return { name, pass: true, detail: inbox };
  } catch {
    return { name, pass: false, detail: `not writable: ${inbox}` };
  }
}

function checkOpenAIToken(agentId: string): Check {
  const name = "OpenAI token";
  const tokenPath = join(homedir(), ".tps", "auth", `openai-${agentId}.json`);
  if (!existsSync(tokenPath)) return { name, pass: false, detail: "not found (agent may not use OpenAI)" };
  try {
    const data = JSON.parse(readFileSync(tokenPath, "utf-8"));
    const exp = data.expiresAt ?? data.expires_at;
    if (!exp) return { name, pass: true, detail: "present (no expiry field)" };
    const expiresAt = new Date(exp);
    const msLeft = expiresAt.getTime() - Date.now();
    if (msLeft < 0) return { name, pass: false, detail: `expired ${relTime(expiresAt.toISOString())}` };
    if (msLeft < 60 * 60 * 1000) return { name, pass: false, detail: `expires in ${Math.round(msLeft / 60_000)}m — refresh needed` };
    return { name, pass: true, detail: `valid, expires ${relTime(expiresAt.toISOString())} from now` };
  } catch (e) {
    return { name, pass: false, detail: `parse error: ${(e as Error).message}` };
  }
}

function checkProcess(workspace: string | undefined, agentId: string): Check {
  const name = "Agent process";
  const ws = workspace ?? join(homedir(), "ops", agentId);
  const pidFile = join(ws, ".tps-agent.pid");
  if (!existsSync(pidFile)) return { name, pass: false, detail: "no PID file (agent not started)" };
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    if (Number.isNaN(pid)) return { name, pass: false, detail: "invalid PID file" };
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return { name, pass: true, detail: `PID ${pid} alive` };
    } catch {
      return { name, pass: false, detail: `PID ${pid} dead (stale PID file)` };
    }
  } catch (e) {
    return { name, pass: false, detail: `error reading PID file: ${(e as Error).message}` };
  }
}

function checkCursor(agentId: string): Check {
  const name = "Task cursor";
  const cursorPath = join(homedir(), ".tps", "cursors", `${agentId}-task-loop.json`);
  if (!existsSync(cursorPath)) return { name, pass: true, detail: "no cursor (first boot)" };
  try {
    const { since } = JSON.parse(readFileSync(cursorPath, "utf-8"));
    return { name, pass: true, detail: `last poll ${relTime(since)}` };
  } catch {
    return { name, pass: false, detail: "cursor file corrupt" };
  }
}

async function checkFlair(agentId: string, flairUrl: string, keyPath: string): Promise<Check> {
  const name = "Flair connectivity";
  if (!existsSync(keyPath)) return { name, pass: false, detail: "skipped (key missing)" };
  try {
    const flair = createFlairClient(agentId, flairUrl, keyPath);
    const online = await flair.ping();
    if (!online) return { name, pass: false, detail: `unreachable at ${flairUrl}` };
    const agent = await flair.getAgent(agentId);
    if (!agent) return { name, pass: false, detail: `authenticated but agent '${agentId}' not registered` };
    return { name, pass: true, detail: `connected, status: ${(agent as unknown as Record<string, unknown>).status ?? "unknown"}` };
  } catch (e) {
    return { name, pass: false, detail: `error: ${(e as Error).message}` };
  }
}

export async function runAgentHealthcheck(opts: HealthcheckOpts): Promise<void> {
  const agentId = opts.agentId ?? process.env.TPS_AGENT_ID ?? "anvil";
  const flairUrl = opts.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const keyPath = opts.keyPath ?? join(homedir(), ".tps", "identity", `${agentId}.key`);
  const mailDir = opts.mailDir ?? join(homedir(), ".tps", "mail");
  const nc = opts.noColor ?? false;

  const checks: Check[] = [
    checkKey(keyPath),
    checkMailDir(mailDir, agentId),
    checkOpenAIToken(agentId),
    checkProcess(opts.workspace, agentId),
    checkCursor(agentId),
  ];

  // Async check last (network)
  checks.push(await checkFlair(agentId, flairUrl, keyPath));

  const allPass = checks.every(c => c.pass);

  if (opts.json) {
    console.log(JSON.stringify({ agentId, healthy: allPass, checks }, null, 2));
    return;
  }

  console.log();
  console.log(`${bold(`⚒️  Agent healthcheck: ${agentId}`, nc)}`);
  console.log(dim("─".repeat(50), nc));
  for (const c of checks) {
    const icon = c.pass ? green("✓", nc) : red("✗", nc);
    const label = c.name.padEnd(20);
    console.log(`  ${icon} ${label} ${dim(c.detail, nc)}`);
  }
  console.log(dim("─".repeat(50), nc));
  console.log(`  ${allPass ? green("healthy", nc) : red("unhealthy", nc)}`);
  console.log();

  if (!allPass) process.exit(1);
}
