import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface StatsArgs {
  today?: boolean;
  agent?: string;
  costs?: boolean;
}

type Event = {
  ts?: string;
  agent?: string;
  type?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const DEFAULT_RATES: Record<string, { in: number; out: number }> = {
  anthropic: { in: 3, out: 15 },
  openai: { in: 5, out: 15 },
  google: { in: 1.25, out: 5 },
  ollama: { in: 0, out: 0 },
};

function eventsDir(): string {
  return join(process.env.HOME || homedir(), ".tps", "events");
}

function readEvents(todayOnly: boolean): Event[] {
  const dir = eventsDir();
  if (!existsSync(dir)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"))
    .filter((f) => !todayOnly || f.includes(today));

  const out: Event[] = [];
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf-8").split(/\n+/).filter(Boolean);
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignore invalid lines
      }
    }
  }
  return out;
}

export function aggregateStats(events: Event[], agent?: string) {
  const rows = new Map<string, { requests: number; inTok: number; outTok: number; cacheRead: number; cacheWrite: number }>();
  for (const e of events) {
    if (e.type !== "llm.request") continue;
    if (agent && e.agent !== agent) continue;
    const key = `${e.provider || "unknown"}:${e.model || "unknown"}`;
    const cur = rows.get(key) || { requests: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 };
    cur.requests += 1;
    cur.inTok += Number(e.inputTokens || 0);
    cur.outTok += Number(e.outputTokens || 0);
    cur.cacheRead += Number(e.cacheReadTokens || 0);
    cur.cacheWrite += Number(e.cacheWriteTokens || 0);
    rows.set(key, cur);
  }
  return rows;
}

export function runStats(args: StatsArgs): void {
  const events = readEvents(!!args.today);
  const rows = aggregateStats(events, args.agent);

  if (rows.size === 0) {
    console.log("No stats events found.");
    return;
  }

  console.log("provider/model                    requests   input      output     cache_r   cache_w");
  for (const [key, r] of rows.entries()) {
    console.log(
      `${key.padEnd(32)} ${String(r.requests).padStart(8)} ${String(r.inTok).padStart(10)} ${String(r.outTok).padStart(10)} ${String(r.cacheRead).padStart(9)} ${String(r.cacheWrite).padStart(9)}`
    );
  }

  if (args.costs) {
    let total = 0;
    for (const [key, r] of rows.entries()) {
      const provider = key.split(":")[0];
      const rate = DEFAULT_RATES[provider] || { in: 0, out: 0 };
      total += (r.inTok / 1_000_000) * rate.in + (r.outTok / 1_000_000) * rate.out;
    }
    console.log(`Estimated cost: $${total.toFixed(4)}`);
  }
}
