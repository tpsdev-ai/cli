/**
 * flair-task-loop.ts — Polls OrgEventCatchup for task.assigned events
 * targeting this agent. Runtime-agnostic: works without OpenClaw.
 *
 * Usage:
 *   import { startTaskLoop, TaskHandler } from "./flair-task-loop.js";
 *   startTaskLoop(flairClient, "anvil", async (event) => {
 *     slog("Got task:", event.summary, event.refId);
 *   });
 */

import type { FlairClient } from "./flair-client.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:flair");


export interface OrgEvent {
  id: string;
  kind: string;
  authorId: string;
  targetIds?: string[];
  summary: string;
  detail?: string;
  refId?: string;
  scope?: string;
  createdAt: string;
  expiresAt?: string;
}

export type TaskHandler = (event: OrgEvent) => Promise<void>;

const DEFAULT_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const CURSOR_DIR = join(homedir(), ".tps", "cursors");

function cursorPath(agentId: string): string {
  return join(CURSOR_DIR, `${agentId}-task-loop.json`);
}

function loadCursor(agentId: string): string {
  try {
    const data = JSON.parse(readFileSync(cursorPath(agentId), "utf-8"));
    if (data.since) return data.since;
  } catch {}
  // First boot: look back 1 hour to catch recently-assigned tasks
  return new Date(Date.now() - 3_600_000).toISOString();
}

function saveCursor(agentId: string, since: string): void {
  try {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(cursorPath(agentId), JSON.stringify({ since, updatedAt: new Date().toISOString() }));
  } catch (e) {
    const err = e as Error;
    swarn(`[${agentId}] Failed to persist cursor: ${err.message}`);
  }
}

export function startTaskLoop(
  flair: FlairClient,
  agentId: string,
  handler: TaskHandler,
  opts: { pollIntervalMs?: number; kinds?: string[] } = {},
): { stop: () => void } {
  const basePollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const kinds = new Set(opts.kinds ?? ["task.assigned"]);
  let since = loadCursor(agentId);
  let running = true;
  let consecutiveErrors = 0;
  const seen = new Set<string>();

  async function poll() {
    while (running) {
      try {
        const events: OrgEvent[] = await (flair as any).request(
          "GET",
          `/OrgEventCatchup/${agentId}?since=${since}`,
        );

        consecutiveErrors = 0; // reset backoff on success

        for (const event of events ?? []) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);

          if (!kinds.has(event.kind)) continue;

          const targets = event.targetIds ?? [];
          if (targets.length > 0 && !targets.includes(agentId)) continue;

          slog(`[${agentId}] Task received: ${event.kind} — ${event.summary}`);
          try {
            await handler(event);
          } catch (e) {
            const err = e as Error;
            serror(`[${agentId}] Task handler error for ${event.id}: ${err.message}`);
          }
        }

        if (events && events.length > 0) {
          since = events[events.length - 1].createdAt;
          saveCursor(agentId, since);
        }

        // Cap seen set
        if (seen.size > 1000) {
          const arr = [...seen];
          arr.splice(0, arr.length - 500);
          seen.clear();
          for (const id of arr) seen.add(id);
        }
      } catch (e) {
        const err = e as Error;
        consecutiveErrors++;
        swarn(`[${agentId}] Task loop poll error: ${err.message}`);
      }

      // Exponential backoff on errors, capped at MAX_BACKOFF_MS
      const delay = consecutiveErrors > 0
        ? Math.min(basePollMs * 2 ** (consecutiveErrors - 1), MAX_BACKOFF_MS)
        : basePollMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  poll();
  slog(`[${agentId}] Task loop started (polling every ${basePollMs / 1000}s, cursor: ${since})`);
  return { stop: () => { running = false; } };
}
