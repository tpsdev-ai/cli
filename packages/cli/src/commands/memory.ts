/**
 * tps memory — Human control plane for agent memory governance.
 *
 * Subcommands:
 *   review <agentId>        List memories pending promotion (promotionStatus=pending)
 *   approve <memoryId>      Promote to permanent (admin only — enforced server-side)
 *   reject <memoryId>       Reject promotion (stays standard)
 *   archive <memoryId>      Soft-delete (hidden from search, recoverable)
 *   unarchive <memoryId>    Restore archived memory
 *   purge <memoryId>        Hard-delete (admin only — enforced server-side)
 *   list <agentId>          List memories with optional filters
 *   show <memoryId>         Show full memory record
 *   search <agentId> <q>    Semantic search (excludes archived)
 */

import { createFlairClient, defaultFlairKeyPath, type Memory } from "../utils/flair-client.js";

export interface MemoryArgs {
  action: "review" | "approve" | "reject" | "archive" | "unarchive" | "purge" | "list" | "show" | "search";
  agentId?: string;
  memoryId?: string;
  query?: string;
  flairUrl?: string;
  json?: boolean;
  durability?: string;
  limit?: number;
  includeArchived?: boolean;
  keyPath?: string;
}

function truncate(s: string, n = 60): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatMemoryRow(m: Memory): string {
  const date = m.createdAt?.slice(0, 10) ?? "?";
  const status = m.promotionStatus ? ` [${m.promotionStatus}]` : "";
  const arch = m.archived ? " [archived]" : "";
  return `${m.id.padEnd(30)} ${date}  ${m.durability ?? "standard"}${status}${arch}\n  ${truncate(m.content)}`;
}

export async function runMemory(args: MemoryArgs): Promise<void> {
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";

  // For governance ops (approve/reject/archive/purge) the admin authenticates as themselves
  // The agentId used for signing is the CLI operator's configured agent (default: from env)
  const operatorId = process.env.TPS_AGENT_ID ?? args.agentId ?? "admin";
  const flair = createFlairClient(operatorId, flairUrl, args.keyPath ?? defaultFlairKeyPath(operatorId));

  switch (args.action) {
    case "review": {
      if (!args.agentId) {
        console.error("Usage: tps memory review <agentId>");
        process.exit(1);
      }
      const all = await flair.listMemoriesFull({ agentId: args.agentId, limit: args.limit ?? 50 });
      const pending = all.filter((m) => m.promotionStatus === "pending");

      if (args.json) {
        console.log(JSON.stringify(pending, null, 2));
        break;
      }
      if (pending.length === 0) {
        console.log(`No memories pending review for ${args.agentId}.`);
        break;
      }
      console.log(`Memories pending promotion for ${args.agentId} (${pending.length}):\n`);
      for (const m of pending) console.log(formatMemoryRow(m));
      break;
    }

    case "approve": {
      if (!args.memoryId) { console.error("Usage: tps memory approve <memoryId>"); process.exit(1); }
      await flair.approveMemory(args.memoryId);
      console.log(`✓ Memory ${args.memoryId} promoted to permanent.`);
      break;
    }

    case "reject": {
      if (!args.memoryId) { console.error("Usage: tps memory reject <memoryId>"); process.exit(1); }
      await flair.rejectMemory(args.memoryId);
      console.log(`✗ Memory ${args.memoryId} rejected. Stays standard.`);
      break;
    }

    case "archive": {
      if (!args.memoryId) { console.error("Usage: tps memory archive <memoryId>"); process.exit(1); }
      await flair.archiveMemory(args.memoryId);
      console.log(`Memory ${args.memoryId} archived (hidden from search).`);
      break;
    }

    case "unarchive": {
      if (!args.memoryId) { console.error("Usage: tps memory unarchive <memoryId>"); process.exit(1); }
      await flair.unarchiveMemory(args.memoryId);
      console.log(`Memory ${args.memoryId} restored.`);
      break;
    }

    case "purge": {
      if (!args.memoryId) { console.error("Usage: tps memory purge <memoryId>"); process.exit(1); }
      await flair.purgeMemory(args.memoryId);
      console.log(`Memory ${args.memoryId} permanently deleted.`);
      break;
    }

    case "list": {
      if (!args.agentId) { console.error("Usage: tps memory list <agentId> [--durability permanent] [--limit 20]"); process.exit(1); }
      const memories = await flair.listMemoriesFull({
        agentId: args.agentId,
        durability: args.durability,
        limit: args.limit ?? 20,
      });
      const filtered = args.includeArchived ? memories : memories.filter((m) => !m.archived);

      if (args.json) { console.log(JSON.stringify(filtered, null, 2)); break; }
      if (filtered.length === 0) { console.log(`No memories for ${args.agentId}.`); break; }
      for (const m of filtered) console.log(formatMemoryRow(m));
      console.log(`\n${filtered.length} result(s).`);
      break;
    }

    case "show": {
      if (!args.memoryId) { console.error("Usage: tps memory show <memoryId>"); process.exit(1); }
      const m = await flair.getMemory(args.memoryId);
      if (args.json) { console.log(JSON.stringify(m, null, 2)); break; }
      console.log(`ID:       ${m.id}`);
      console.log(`Agent:    ${m.agentId}`);
      console.log(`Durable:  ${m.durability}`);
      console.log(`Status:   ${m.promotionStatus ?? "none"}`);
      console.log(`Archived: ${m.archived ?? false}`);
      console.log(`Created:  ${m.createdAt}`);
      console.log(`Updated:  ${m.updatedAt}`);
      if (m.promotedBy) console.log(`ApprovedBy: ${m.promotedBy} at ${m.promotedAt}`);
      if (m.archivedBy) console.log(`ArchivedBy: ${m.archivedBy} at ${m.archivedAt}`);
      console.log(`\n${m.content}`);
      break;
    }

    case "search": {
      if (!args.agentId || !args.query) {
        console.error("Usage: tps memory search <agentId> <query>");
        process.exit(1);
      }
      const agentFlair = createFlairClient(args.agentId, flairUrl, args.keyPath ?? defaultFlairKeyPath(args.agentId));
      const results = await agentFlair.search(args.query, args.limit ?? 10);
      if (args.json) { console.log(JSON.stringify(results, null, 2)); break; }
      if (results.length === 0) { console.log("No results."); break; }
      for (const r of results) {
        console.log(`[${r._score.toFixed(3)}] ${r.id}: ${truncate(r.content, 120)}`);
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown memory action: ${_}`);
      process.exit(1);
    }
  }
}
