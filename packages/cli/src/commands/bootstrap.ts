import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { sanitizeIdentifier, sanitizeFreeText, sanitizeModelIdentifier } from "../schema/sanitizer.js";
import { workspacePath as resolveWorkspacePath, resolveTeamId, branchRoot as workspaceRoot } from "../utils/workspace.js";
import { runCommandUnderNono } from "../utils/nono.js";
import { deliverToSandbox } from "../utils/relay.js";
import { readOpenClawConfig, findOpenClawConfig, type OpenClawConfig } from "../utils/config.js";

export interface BootstrapArgs {
  agentId: string;
  configPath?: string;
  channel?: string;
}

interface HealthResult {
  workspaceWritable: boolean;
  gatewayReachable: boolean;
  mailOperational: boolean;
}


const REQUIRED_FILES: Record<string, string> = {
  "SOUL.md": "# SOUL\n\n**Role:** Agent\n**Communication Style:** concise and practical\n",
  "IDENTITY.md": "# IDENTITY.md\n\n**Name:** Agent\n**Emoji:** 🤖\n**Creature:** AI\n",
  "USER.md": "# USER.md\n\n**User:** Nathan\n\nAgent serves as requested operations agent.\n",
  "AGENTS.md": "# AGENTS\n\nWorkspace conventions for this agent:\n\n- Follow SOUL and IDENTITY.\n- Use safe mailbox and relay boundaries.\n- Keep changes minimal and auditable.\n",
  "TOOLS.md": "# TOOLS\n\nLocal notes about installed tools and environment.\n",


  "HEARTBEAT.md": "# HEARTBEAT\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n\n# Add tasks below when you want the agent to check something periodically.\n",
};
const BOOTSTRAP_STATE_DIR = join(process.env.HOME || homedir(), ".tps", "bootstrap-state");
const BOOTSTRAP_MARKER = ".bootstrap-complete";

function assertAgent(agentId: string): string {
  const safe = sanitizeIdentifier(agentId);
  if (!agentId || safe !== agentId) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
  return safe;
}

function ensureFiles(workspace: string, agentId: string): void {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, "memory"), { recursive: true });

  for (const [file, content] of Object.entries(REQUIRED_FILES)) {
    const path = join(workspace, file);
    if (existsSync(path)) continue;

    if (file === "SOUL.md") {
      writeFileSync(path, content.replace("Role:** Agent", `Role:** ${sanitizeFreeText(agentId)}`), "utf-8");
    } else if (file === "IDENTITY.md") {
      writeFileSync(path, content.replace("**Name:** Agent", `**Name:** ${sanitizeFreeText(agentId)}`), "utf-8");
    } else {
      writeFileSync(path, content, "utf-8");
    }
  }
}

function resolveOpenClawConfigPath(teamRoot: string, workspace: string, explicit?: string): string {
  if (explicit) return explicit;

  const candidates = [
    join(workspace, ".openclaw", "openclaw.json"),
    join(teamRoot, ".openclaw", "openclaw.json"),
    findOpenClawConfig(workspace),
    join(teamRoot, "openclaw.json"),
    join(process.env.HOME || homedir(), ".openclaw", "openclaw.json"),
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return join(teamRoot, ".openclaw", "openclaw.json");
}

function readConfig(configPath: string): OpenClawConfig {
  if (!existsSync(configPath)) return {};
  try {
    return readOpenClawConfig(configPath);
  } catch (err) {
    throw new Error(`Invalid JSON in openclaw config: ${(err as Error).message}`);
  }
}

function upsertAgentEntry(
  configPath: string,
  config: OpenClawConfig,
  agentId: string,
  workspace: string,
  channel: string,
  modelHint?: string
): OpenClawConfig {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.list ??= [];

  const list = config.agents.list;
  const existing = list.find((a) => a.id === agentId);
  const model = sanitizeModelIdentifier(
    String(
      modelHint || existing?.model || config.agents.defaults.model || process.env.TPS_BOOTSTRAP_MODEL || "anthropic/claude-sonnet-4-20250514"
    )
  );

  const workspaceAgent = {
    id: agentId,
    name: existing?.name || agentId,
    model,
    workspace,
    agentDir: workspace,
    channel,
  };

  if (!existing) {
    list.push(workspaceAgent);
  } else {
    Object.assign(existing, workspaceAgent);
  }

  config.agents.defaults.workspace = workspace;

  // Channel bindings
  const channelName = sanitizeIdentifier(channel || String(config.agents.defaults.channel || "discord"));
  config.agents.defaults.channel = channelName;

  const token = process.env.TPS_BOOTSTRAP_DISCORD_TOKEN;
  const channelId = process.env.TPS_BOOTSTRAP_DISCORD_CHANNEL;
  if (token || channelId) {
    const channels = (typeof config.channels === "object" && config.channels ? (config.channels as Record<string, unknown>) : {});
    const existing = (typeof channels.discord === "object" && channels.discord ? channels.discord : {});
    channels.discord = {
      ...(typeof existing === "object" && existing ? existing : {}),
      ...(token ? { token } : {}),
      ...(channelId ? { id: channelId } : {}),
    };
    config.channels = channels as OpenClawConfig["channels"];
  }

  config.agents.list = list;
  return config;
}

function writeConfig(configPath: string, config: OpenClawConfig): void {
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function healthReadWrite(workspace: string): boolean {
  const marker = join(workspace, ".bootstrap-rw-check");
  const markerValue = `bootstrap-check:${randomUUID()}`;
  try {
    writeFileSync(marker, markerValue, "utf-8");
    const raw = readFileSync(marker, "utf-8").trim();
    return raw === markerValue;
  } finally {
    try {
      writeFileSync(marker, "", "utf-8");
    } catch {}
  }
}

function healthGateway(): boolean {
  return runCommandUnderNono("tps-bootstrap", {}, ["openclaw", "gateway", "status"]) === 0;
}

function healthMail(teamWorkspace: string, teamId: string): boolean {
  const inbox = join(teamWorkspace, "mail", "inbox", "new");
  mkdirSync(inbox, { recursive: true });
  const before = readdirSync(inbox).filter((f) => f.endsWith(".json")).length;

  const msg = {
    id: randomUUID(),
    from: "system:bootstrap",
    to: teamId,
    body: "bootstrap health check probe",
    timestamp: new Date().toISOString(),
  };

  try {
    deliverToSandbox(teamId, msg);
  } catch {
    return false;
  }

  const after = readdirSync(inbox).filter((f) => f.endsWith(".json")).length;

  if (after <= before) {
    return false;
  }

  // mark probe as received by attempting to move one file to cur (read path) and parse
  try {
    const files = readdirSync(inbox)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    const probe = join(inbox, files[0]!);
    const raw = readFileSync(probe, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.from?.startsWith("system:")) return false;
    mkdirSync(join(teamWorkspace, "mail", "inbox", "cur"), { recursive: true });
    renameSync(probe, join(teamWorkspace, "mail", "inbox", "cur", files[0]!));
  } catch {
    return false;
  }

  return true;
}

function sendIntroduction(teamId: string, teamWorkspace: string, body: string): void {
  const inbox = join(teamWorkspace, "mail", "inbox", "new");
  mkdirSync(inbox, { recursive: true });

  deliverToSandbox(teamId, {
    id: randomUUID(),
    from: "system:bootstrap",
    to: teamId,
    body,
    timestamp: new Date().toISOString(),
  });
}

function writeMarker(teamId: string, payload: string): void {
  const path = join(BOOTSTRAP_STATE_DIR, teamId, BOOTSTRAP_MARKER);
  mkdirSync(join(BOOTSTRAP_STATE_DIR, teamId), { recursive: true });
  writeFileSync(path, payload, "utf-8");
}

function runHealthChecks(agentWorkspace: string, teamWorkspace: string, teamId: string): HealthResult {
  return {
    workspaceWritable: healthReadWrite(agentWorkspace),
    gatewayReachable: healthGateway(),
    mailOperational: healthMail(teamWorkspace, teamId),
  };
}

function readNameAndRole(workspace: string): { name: string; role: string } {
  const soul = join(workspace, "SOUL.md");
  let name = "Agent";
  let role = "agent";

  if (existsSync(soul)) {
    const raw = readFileSync(soul, "utf-8");
    const n = /\*\*Name:\*\*\s*([^\n]+)/i.exec(raw)?.[1]?.trim();
    const r = /\*\*Role:\*\*\s*([^\n]+)/i.exec(raw)?.[1]?.trim();
    if (n) name = n;
    if (r) role = r;
  }

  return { name, role };
}

function verifyRoster(config: OpenClawConfig, agentId: string): boolean {
  const list = config.agents?.list ?? [];
  return list.some((agent) => agent.id === agentId);
}

export async function runBootstrap(args: BootstrapArgs): Promise<void> {
  const agentId = assertAgent(args.agentId);
  const teamId = resolveTeamId(agentId);
  const workspace = resolveWorkspacePath(agentId);
  if (!existsSync(workspace)) {
    throw new Error(`No workspace found for ${agentId}. Run tps office start ${agentId} first.`);
  }

  const teamRoot = join(workspaceRoot(), teamId);
  const teamWorkspace = resolveWorkspacePath(teamId);

  ensureFiles(workspace, agentId);

  const modelHint = process.env.TPS_BOOTSTRAP_MODEL;
  const channel = args.channel || process.env.TPS_BOOTSTRAP_CHANNEL || "discord";

  const configPath = resolveOpenClawConfigPath(teamRoot, workspace, args.configPath);
  const config = readConfig(configPath);
  const updatedConfig = upsertAgentEntry(configPath, config, agentId, workspace, channel, modelHint);
  writeConfig(configPath, updatedConfig);

  if (!verifyRoster(updatedConfig, agentId)) {
    throw new Error("Failed to register agent in roster");
  }

  const health = runHealthChecks(workspace, teamWorkspace, teamId);
  if (!health.workspaceWritable) throw new Error("Workspace read/write check failed");
  if (!health.gatewayReachable) throw new Error("Gateway reachability check failed");
  if (!health.mailOperational) throw new Error("Mail send/receive check failed");

  const { name, role } = readNameAndRole(workspace);
  sendIntroduction(
    teamId,
    teamWorkspace,
    `Welcome ${name} (${role})\nModel: ${updatedConfig.agents?.list?.find((a) => a.id === agentId)?.model}\nCapabilities summary: open mail, run workspace tools, execute tasks.`
  );

  writeMarker(teamId, JSON.stringify({
    agentId,
    workspace,
    teamId,
    completedAt: new Date().toISOString(),
    health,
  }, null, 2) + "\n");

  console.log(`✓ Bootstrap complete for ${agentId}`);
  console.log(`Model: ${updatedConfig.agents?.list?.find((a) => a.id === agentId)?.model}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Marker: ${join(BOOTSTRAP_STATE_DIR, teamId, BOOTSTRAP_MARKER)}`);
}
