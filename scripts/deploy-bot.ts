#!/usr/bin/env bun
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

function resolveAgentId(): string {
  if (process.env.DEPLOY_BOT_AGENT) return process.env.DEPLOY_BOT_AGENT;
  const agentFile = join(HOME, ".tps", "identity", "agent.json");
  if (existsSync(agentFile)) {
    try {
      const parsed = JSON.parse(readFileSync(agentFile, "utf-8"));
      if (parsed?.id) return String(parsed.id);
    } catch {}
  }
  throw new Error("Could not determine agent ID. Set DEPLOY_BOT_AGENT env var.");
}

const AGENT_ID = resolveAgentId();
const TPS_DIR = process.env.DEPLOY_BOT_TPS_DIR ?? join(HOME, "tps");
const HOST_AGENT = process.env.DEPLOY_BOT_HOST_AGENT ?? "rockit";
const RUN_ALLOWLIST = (process.env.DEPLOY_BOT_RUN_CMDS ?? "df -h,uptime,bun --version,git log --oneline -5")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = Number(process.env.DEPLOY_BOT_POLL_MS ?? "5000");
const ALLOWED_SENDERS = (process.env.DEPLOY_BOT_ALLOWED_SENDERS ?? HOST_AGENT)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAIL_NEW_DIR = join(HOME, ".tps", "mail", AGENT_ID, "new");
const MAIL_CUR_DIR = join(HOME, ".tps", "mail", AGENT_ID, "cur");

type MailRow = { id: string; from: string; body: string };

function ensureDirs() {
  mkdirSync(MAIL_NEW_DIR, { recursive: true });
  mkdirSync(MAIL_CUR_DIR, { recursive: true });
}

function log(msg: string) {
  console.log(`[deploy-bot ${new Date().toISOString()}] ${msg}`);
}

function pollNewMail(): MailRow[] {
  if (!existsSync(MAIL_NEW_DIR)) return [];
  const out: MailRow[] = [];
  for (const file of readdirSync(MAIL_NEW_DIR)) {
    const src = join(MAIL_NEW_DIR, file);
    try {
      const row = JSON.parse(readFileSync(src, "utf-8")) as MailRow;
      if (!row?.id || typeof row.body !== "string") continue;
      out.push(row);
      renameSync(src, join(MAIL_CUR_DIR, file));
    } catch (e: any) {
      log(`WARN parse failed for ${file}: ${e.message}`);
    }
  }
  return out;
}

function reply(to: string, body: string) {
  const r = spawnSync("tps", ["mail", "send", to, body], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (r.error) {
    log(`WARN reply to ${to} failed: ${r.error.message}`);
  } else {
    log(`→ replied to ${to}`);
  }
}

function cmdDeploy(): string {
  const steps: string[] = [];
  try {
    const pull = execSync(`git -C ${TPS_DIR} pull`, { encoding: "utf-8", timeout: 60_000 }).trim();
    steps.push(`git pull: ${pull}`);
  } catch (e: any) {
    return `deploy failed at git pull: ${e.message}`;
  }

  try {
    execSync(`bun install --cwd ${TPS_DIR}`, { encoding: "utf-8", timeout: 120_000 });
    steps.push("bun install: ok");
  } catch (e: any) {
    return `deploy failed at bun install: ${e.message}`;
  }

  try {
    execSync(`bun run build --cwd ${TPS_DIR}`, { encoding: "utf-8", timeout: 120_000 });
    steps.push("bun run build: ok");
  } catch (e: any) {
    return `deploy failed at bun run build: ${e.message}`;
  }

  try {
    spawnSync("tps", ["branch", "stop"], { encoding: "utf-8", timeout: 10_000 });
    spawnSync("tps", ["branch", "start"], { encoding: "utf-8", timeout: 5_000 });
    steps.push("daemon restarted");
  } catch (e: any) {
    steps.push(`daemon restart failed: ${e.message}`);
  }

  try {
    const head = execSync(`git -C ${TPS_DIR} log --oneline -1`, { encoding: "utf-8" }).trim();
    steps.push(`HEAD: ${head}`);
  } catch {}

  return `✅ deployed\n${steps.join("\n")}`;
}

function cmdStatus(): string {
  const lines: string[] = [];
  try {
    const head = execSync(`git -C ${TPS_DIR} log --oneline -1`, { encoding: "utf-8" }).trim();
    lines.push(`HEAD: ${head}`);
  } catch {
    lines.push("HEAD: unknown");
  }

  const pidFile = join(HOME, ".tps", "branch.pid");
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, "utf-8").trim();
    lines.push(`daemon: running (pid ${pid})`);
  } else {
    lines.push("daemon: stopped");
  }

  try {
    lines.push(`uptime: ${execSync("uptime", { encoding: "utf-8" }).trim()}`);
  } catch {}

  try {
    const disk = execSync("df -h /", { encoding: "utf-8" }).split("\n")[1]?.trim();
    if (disk) lines.push(`disk: ${disk}`);
  } catch {}

  return lines.join("\n");
}

function cmdRun(cmd: string): string {
  const normalized = cmd.trim();
  if (!RUN_ALLOWLIST.includes(normalized)) {
    return `❌ command not in allowlist: ${normalized}\nAllowed: ${RUN_ALLOWLIST.join(", ")}`;
  }
  try {
    const out = execSync(normalized, { encoding: "utf-8", timeout: 30_000 }).trim();
    return `$ ${normalized}\n${out}`;
  } catch (e: any) {
    return `$ ${normalized}\nerror: ${e.message}`;
  }
}

export function dispatch(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "deploy") return cmdDeploy();
  if (trimmed === "status") return cmdStatus();
  if (trimmed.startsWith("run ")) return cmdRun(trimmed.slice(4));
  return `❓ unknown command: ${trimmed}\nKnown commands: deploy, status, run <cmd>`;
}

function tick() {
  for (const msg of pollNewMail()) {
    log(`← command from ${msg.from}: ${msg.body.slice(0, 80)}`);
    if (!ALLOWED_SENDERS.includes(msg.from)) {
      log(`WARN: rejected command from unauthorized sender: ${msg.from}`);
      continue;
    }
    const out = dispatch(msg.body);
    reply(msg.from || HOST_AGENT, out);
  }
}

if (import.meta.main) {
  log(`Deploy bot starting. Agent=${AGENT_ID} TPS_DIR=${TPS_DIR} poll=${POLL_MS}ms`);
  log(`Run allowlist: ${RUN_ALLOWLIST.join(", ")}`);
  log(`Allowed senders: ${ALLOWED_SENDERS.join(", ")}`);
  ensureDirs();
  tick();
  setInterval(tick, POLL_MS);

  process.on("SIGTERM", () => {
    log("Shutting down");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("Shutting down");
    process.exit(0);
  });
}
