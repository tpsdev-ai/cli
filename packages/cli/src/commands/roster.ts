import { findOpenClawConfig, getAgentList, readOpenClawConfig, resolveConfigPath, resolveWorkspace, type OpenClawAgent } from "../utils/config.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { getAgentInfo } from "../utils/agent-info.js";
import { createFlairClient } from "../utils/flair-client.js";
import { sendMail } from "../utils/mail-bridge.js";
import { loadHostIdentityId } from "../utils/identity.js";
import { homedir } from "node:os";
import { join } from "node:path";

interface RosterArgs {
  action: "list" | "show" | "find" | "invite";
  agent?: string;
  channel?: string;
  message?: string;
  flairUrl?: string;
  keyPath?: string;
  mailDir?: string;
  json?: boolean;
  configPath?: string;
}

function getPrimaryModel(agent: OpenClawAgent): string {
  const model = agent.model;
  if (!model) return "(default)";
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && "primary" in model) {
    return String((model as Record<string, unknown>).primary || "(default)");
  }
  return "(default)";
}

function resolveConfig(args: RosterArgs) {
  const configPath = resolveConfigPath(args.configPath) || findOpenClawConfig();
  if (!configPath) {
    console.error("No openclaw.json found. Use --config <path>.");
    process.exit(1);
  }
  return readOpenClawConfig(configPath);
}

export async function runRoster(args: RosterArgs): Promise<void> {
  const config = resolveConfig(args);
  const agents = getAgentList(config);

  switch (args.action) {
    case "list": {
      const rows = agents.map((a) => ({
        id: a.id,
        name: a.name || a.id,
        model: getPrimaryModel(a),
        status: "active",
      }));

      if (args.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("No agents found.");
      } else {
        for (const row of rows) {
          console.log(`- ${row.name} (${row.id}) · ${row.model} · ${row.status}`);
        }
      }
      return;
    }

    case "show": {
      if (!args.agent) {
        console.error("Usage: tps roster show <agent>");
        process.exit(1);
      }

      const safeAgent = sanitizeIdentifier(args.agent);
      if (safeAgent !== args.agent) {
        console.error(`Invalid agent id: ${args.agent}`);
        process.exit(1);
      }

      const agent = agents.find(
        (a) => a.id.toLowerCase() === args.agent!.toLowerCase() || a.name?.toLowerCase() === args.agent!.toLowerCase()
      );
      if (!agent) {
        console.error(`Agent "${args.agent}" not found`);
        process.exit(1);
      }

      const ws = resolveWorkspace(agent, config);
      const info = getAgentInfo(agent.id, ws || undefined);

      const card = {
        id: agent.id,
        name: agent.name || agent.id,
        model: getPrimaryModel(agent),
        role: info.profile.role,
        emoji: info.profile.emoji,
        vibe: info.profile.vibe,
        contacts: (agent.contacts as Record<string, unknown> | undefined) || {},
        capabilities: (agent.capabilities as Record<string, unknown> | undefined) || {},
        mail: info.mail,
        memory: info.memory,
        workspaceFiles: info.workspaceFileCount,
      };

      if (args.json) {
        console.log(JSON.stringify(card, null, 2));
      } else {
        const label = info.profile.emoji ? `${info.profile.emoji} ${card.name}` : card.name;
        console.log(`${label} (${card.id})`);
        if (info.profile.role) console.log(`  role: ${info.profile.role}`);
        if (info.profile.vibe) console.log(`  vibe: ${info.profile.vibe}`);
        console.log(`  model: ${card.model}`);
        if (info.mail.total > 0) {
          console.log(`  mail: ${info.mail.unread} unread, ${info.mail.read} read (${info.mail.total} total)`);
        } else {
          console.log(`  mail: no messages`);
        }
        if (info.memory.latestDate) {
          console.log(`  memory: ${info.memory.fileCount} journal${info.memory.fileCount !== 1 ? "s" : ""}, latest ${info.memory.latestDate}`);
        }
        console.log(`  workspace: ${info.workspaceFileCount} files`);
        const contacts = (agent.contacts as Record<string, unknown> | undefined) || {};
        if (Object.keys(contacts).length > 0) {
          console.log(`  contacts: ${JSON.stringify(contacts)}`);
        }
      }
      return;
    }

    case "find": {
      if (!args.channel) {
        console.error("Usage: tps roster find --channel <channel>");
        process.exit(1);
      }

      const safeChannel = sanitizeIdentifier(args.channel);
      if (safeChannel !== args.channel) {
        console.error(`Invalid channel: ${args.channel}`);
        process.exit(1);
      }

      const matches: Array<{ id: string; name: string; channel: string; contact: unknown }> = [];
      for (const a of agents) {
        const contacts = (a.contacts as Record<string, unknown> | undefined) || {};
        const value = contacts[args.channel!];
        if (value === undefined || value === null) continue;
        matches.push({
          id: a.id,
          name: a.name || a.id,
          channel: args.channel!,
          contact: value,
        });
      }

      if (args.json) {
        console.log(JSON.stringify(matches, null, 2));
      } else if (matches.length === 0) {
        console.log(`No agents found for channel: ${args.channel}`);
      } else {
        for (const m of matches) {
          console.log(`- ${m.name} (${m.id}) => ${JSON.stringify(m.contact)}`);
        }
      }
      return;
    }
    case "invite": {
      if (!args.agent) {
        console.error("Usage: tps roster invite <agent> [--message <text>]");
        process.exit(1);
      }
      const safeAgent = sanitizeIdentifier(args.agent);
      if (safeAgent !== args.agent) {
        console.error(`Invalid agent id: ${args.agent}`);
        process.exit(1);
      }
      const invitedBy = await resolveInviterId();
      const flair = createFlairClient(invitedBy, args.flairUrl, args.keyPath);
      try {
        await flair.request("GET", `/Identity/${encodeURIComponent(args.agent)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Agent "${args.agent}" not found in Flair identity registry: ${message}`);
        process.exit(1);
      }
      const inviteMessage = buildInviteMessage(args.agent, invitedBy);
      sendMail(args.mailDir ?? join(homedir(), ".tps", "mail"), args.agent, invitedBy, inviteMessage, {
        "X-TPS-Trust": "internal",
        "X-TPS-Sender": invitedBy,
        "X-TPS-Message-Type": "org.invite",
      });
      await flair.publishEvent({
        kind: "org.invited",
        scope: "org",
        summary: `Invited ${args.agent} to TPS`,
        detail: args.message ?? inviteMessage,
        targetIds: [args.agent],
      });
      if (args.json) {
        console.log(JSON.stringify({ status: "invited", agentId: args.agent, invitedBy }, null, 2));
      } else {
        console.log(`Invited ${args.agent} to TPS.`);
      }
      return;
    }
  }
}

// ─── roster dashboard ─────────────────────────────────────────────────────────

interface FlairIdentity {
  id: string;
  agentId?: string;
  name?: string;
  role?: string;
  status?: string;
}

interface OrgEventRecord {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  createdAt: string;
  refId?: string;
}

export async function runDashboard(opts: { flairUrl?: string; json?: boolean; keyPath?: string; agentId?: string }): Promise<void> {
  const flairUrl = opts.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { readFileSync, existsSync } = await import("node:fs");
  const { createPrivateKey, sign } = await import("node:crypto");

  const viewerId = opts.agentId ?? process.env.TPS_AGENT_ID ?? "anvil";
  const keyPath = opts.keyPath ?? join(homedir(), ".tps", "identity", `${viewerId}.key`);

  function makeAuth(method: string, urlPath: string): string | undefined {
    if (!existsSync(keyPath)) return undefined;
    try {
      const raw = readFileSync(keyPath);
      let privKey;
      try { privKey = createPrivateKey(raw); } catch {
        const h = Buffer.from("302e020100300506032b657004220420", "hex");
        privKey = createPrivateKey({ key: Buffer.concat([h, raw]), format: "der", type: "pkcs8" });
      }
      const ts = Date.now().toString();
      const nonce = Math.random().toString(36).slice(2, 10);
      const sig = sign(null, Buffer.from(`${viewerId}:${ts}:${nonce}:${method}:${urlPath}`), privKey).toString("base64");
      return `TPS-Ed25519 ${viewerId}:${ts}:${nonce}:${sig}`;
    } catch { return undefined; }
  }

  // Fetch agents from Flair
  let agents: FlairIdentity[] = [];
  try {
    const auth = makeAuth("GET", "/Agent/");
    const res = await fetch(`${flairUrl}/Agent/`, auth ? { headers: { Authorization: auth } } : {});
    if (res.ok) agents = await res.json() as FlairIdentity[];
    else { console.error(`Cannot reach Flair at ${flairUrl} (HTTP ${res.status}). Is it running?`); process.exit(1); }
  } catch {
    console.error(`Cannot reach Flair at ${flairUrl}. Is it running?`);
    process.exit(1);
  }

  if (agents.length === 0) {
    console.log("No agents registered in Flair.");
    return;
  }

  // Fetch recent OrgEvents for activity
  const recentEvents: OrgEventRecord[] = [];
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, ".000Z");
    const auth = makeAuth("GET", `/OrgEventCatchup/${viewerId}?since=${since}`);
    const res = await fetch(`${flairUrl}/OrgEventCatchup/${viewerId}?since=${since}`, auth ? { headers: { Authorization: auth } } : {});
    if (res.ok) recentEvents.push(...(await res.json() as OrgEventRecord[]));
  } catch { /* non-fatal */ }

  // Build per-agent last event map
  const lastEvent = new Map<string, OrgEventRecord>();
  const lastTask = new Map<string, OrgEventRecord>();
  for (const ev of recentEvents) {
    if (!lastEvent.has(ev.authorId)) lastEvent.set(ev.authorId, ev);
    if ((ev.kind === "task.assigned" || ev.kind === "task.completed") && !lastTask.has(ev.authorId)) {
      lastTask.set(ev.authorId, ev);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(agents.map(a => ({
      ...a,
      lastEvent: lastEvent.get(a.id ?? a.agentId ?? ""),
      lastTask: lastTask.get(a.id ?? a.agentId ?? ""),
    })), null, 2));
    return;
  }

  // Pretty print
  const now = Date.now();
  console.log(`\n⚒️  TPS Office Dashboard — ${agents.length} agents\n`);
  console.log(`${"Agent".padEnd(16)} ${"Role".padEnd(12)} ${"Status".padEnd(10)} ${"Last Activity"}`);
  console.log("─".repeat(72));

  for (const agent of agents) {
    const agId = agent.id ?? agent.agentId ?? "?"; const last = lastEvent.get(agId);
    const task = lastTask.get(agId);
    const ago = last
      ? (() => {
          const ms = now - new Date(last.createdAt).getTime();
          if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
          if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
          return `${Math.round(ms / 3600000)}h ago`;
        })()
      : "no activity";
    const taskInfo = task ? ` [${task.kind}: ${(task.refId ?? task.summary).slice(0, 30)}]` : "";
    const status = agent.status ?? "unknown";
    console.log(
      `${agId.padEnd(16)} ${(agent.role ?? "agent").padEnd(12)} ${status.padEnd(10)} ${ago}${taskInfo}`
    );
  }
  console.log();
}


function buildInviteMessage(agentId: string, invitedBy: string): string {
  return [
    "You have been invited to join TPS.",
    "",
    `Agent: ${agentId}`,
    `Invited by: ${invitedBy}`,
    "",
    "Check your TPS mail and reply when you are online.",
  ].join("\n");
}

async function resolveInviterId(): Promise<string> {
  const explicit = process.env.TPS_AGENT_ID;
  if (explicit) {
    const safe = sanitizeIdentifier(explicit);
    if (safe !== explicit) {
      console.error(`Invalid inviter id: ${explicit}`);
      process.exit(1);
    }
    return explicit;
  }

  const hostId = await loadHostIdentityId();
  const safe = sanitizeIdentifier(hostId);
  if (safe !== hostId) {
    console.error(`Invalid inviter id: ${hostId}`);
    process.exit(1);
  }
  return hostId;
}
