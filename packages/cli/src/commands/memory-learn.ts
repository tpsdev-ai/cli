/**
 * tps memory reflect | consolidate
 *
 * Learning pipeline commands — ops-31.2.
 * These extend tps memory (ops-31.1) with reflection and consolidation.
 *
 * reflect <agentId>    — gather memories, build LLM reflection prompt
 * consolidate <agentId> — review persistent memories for promote/archive/keep
 */

import { createFlairClient } from "../utils/flair-client.js";

export interface MemoryLearnArgs {
  action: "reflect" | "consolidate";
  agentId: string;
  // reflect
  scope?: string;
  since?: string;
  focus?: string;
  tag?: string;
  limit?: number;
  // consolidate
  olderThan?: string;
  durabilityScope?: string;
  // shared
  flairUrl?: string;
  json?: boolean;
  keyPath?: string;
}

export async function runMemoryLearn(args: MemoryLearnArgs): Promise<void> {
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const flair = createFlairClient(args.agentId, flairUrl, args.keyPath);

  switch (args.action) {
    case "reflect": {
      const result = await flair.reflectMemory({
        agentId: args.agentId,
        scope: (args.scope as any) ?? "recent",
        since: args.since,
        maxMemories: args.limit,
        focus: (args.focus as any) ?? "lessons_learned",
        tag: args.tag,
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      console.log(`\n${result.prompt}\n`);
      console.log(`─── ${result.count} source memories ────────────────────────────`);
      for (const m of result.memories) {
        const date = m.createdAt?.slice(0, 10) ?? "?";
        const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        console.log(`  ${m.id} (${date})${tags}`);
        console.log(`    ${m.content.slice(0, 120)}`);
      }
      if (result.suggestedTags.length) {
        console.log(`\nSuggested tags: ${result.suggestedTags.join(", ")}`);
      }
      break;
    }

    case "consolidate": {
      const result = await flair.consolidateMemory({
        agentId: args.agentId,
        scope: (args.durabilityScope as any) ?? "persistent",
        olderThan: args.olderThan,
        limit: args.limit,
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      console.log(`\n${result.prompt}\n`);
      console.log(`─── ${result.candidates.length} candidates ───────────────────────`);
      for (const c of result.candidates) {
        const badge = c.suggestion === "promote" ? "⬆" : c.suggestion === "archive" ? "🗄" : "•";
        const date = c.memory.createdAt?.slice(0, 10) ?? "?";
        console.log(`\n${badge} ${c.suggestion.toUpperCase()} — ${c.memory.id} (${date}, ${c.memory.durability})`);
        console.log(`  Reason: ${c.reason}`);
        console.log(`  ${c.memory.content.slice(0, 120)}`);
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown action: ${_}`);
      process.exit(1);
    }
  }
}
