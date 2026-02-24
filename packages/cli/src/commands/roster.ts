import { findOpenClawConfig, getAgentList, readOpenClawConfig, resolveConfigPath, resolveWorkspace, type OpenClawAgent } from "../utils/config.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { getAgentInfo } from "../utils/agent-info.js";

interface RosterArgs {
  action: "list" | "show" | "find";
  agent?: string;
  channel?: string;
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

export function runRoster(args: RosterArgs): void {
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
  }
}
