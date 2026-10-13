/**
 * flair-task-loop.ts — Polls OrgEventCatchup for task.assigned events
 * targeting this agent. Runtime-agnostic: works without OpenClaw.
 *
 * The loop reads the catch-up feed through `FlairClient.getEventsSince`, which
 * returns the validated envelope read from org-event-read.ts (cli#619). It
 * advances its cursor from the feed's position (Flair's `after` cursor), not
 * from an event timestamp, and persists that position in
 * `~/.tps/cursors/<agentId>-task-loop.json` as `{ position, updatedAt }`,
 * resuming from it on restart.
 *
 * An unavailable feed is logged with its bounded reason and the loop backs
 * off without advancing the cursor; it is not read as an empty feed.
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
import snooplogg from "snooplogg";
import { homeDir } from "./home.js";
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
/** How far back the first read looks when no cursor has been persisted yet. */
const FIRST_BOOT_LOOKBACK_MS = 3_600_000;
function cursorDir(): string {
  return join(homeDir(), ".tps", "cursors");
}

function cursorPath(agentId: string): string {
  return join(cursorDir(), `${agentId}-task-loop.json`);
}

/** The persisted feed position (Flair's `after` cursor), or undefined before the first read. */
function loadCursor(agentId: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(cursorPath(agentId), "utf-8"));
    if (typeof data.position === "string" && data.position !== "") return data.position;
  } catch {}
  return undefined;
}

function saveCursor(agentId: string, position: string): void {
  try {
    mkdirSync(cursorDir(), { recursive: true });
    writeFileSync(cursorPath(agentId), JSON.stringify({ position, updatedAt: new Date().toISOString() }));
  } catch (e) {
    const err = e as Error;
    swarn(`[${agentId}] Failed to persist cursor: ${err.message}`);
  }
}

/** The `since` floor for a read resuming at `position`: its createdAt, or the first-boot lookback. */
function cursorSince(position: string | undefined): Date {
  if (position) {
    const ts = position.slice(0, position.indexOf("\t"));
    if (Number.isFinite(Date.parse(ts))) return new Date(ts);
  }
  return new Date(Date.now() - FIRST_BOOT_LOOKBACK_MS);
}

export function startTaskLoop(
  flair: FlairClient,
  agentId: string,
  handler: TaskHandler,
  opts: { pollIntervalMs?: number; kinds?: string[] } = {},
): { stop: () => void } {
  const basePollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const kinds = new Set(opts.kinds ?? ["task.assigned"]);
  let position = loadCursor(agentId);
  let running = true;
  let consecutiveErrors = 0;
  const seen = new Set<string>();

  async function poll() {
    while (running) {
      try {
        const read = await flair.getEventsSince(agentId, cursorSince(position), position);
        if (read.status === "unavailable") {
          // A failed read is not an empty feed: log its bounded reason and back off
          // without advancing the cursor.
          consecutiveErrors++;
          swarn(`[${agentId}] Task loop catch-up read unavailable (${read.reason})`);
        } else {
          consecutiveErrors = 0; // reset backoff on a successful read

          for (const event of read.events) {
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

          // Advance the cursor from the feed's position, not from event timestamps.
          if (read.nextAfter && read.nextAfter !== position) {
            position = read.nextAfter;
            saveCursor(agentId, position);
          }

          // Cap seen set
          if (seen.size > 1000) {
            const arr = [...seen];
            arr.splice(0, arr.length - 500);
            seen.clear();
            for (const id of arr) seen.add(id);
          }
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
  slog(`[${agentId}] Task loop started (polling every ${basePollMs / 1000}s, position: ${position ?? "none"})`);
  return { stop: () => { running = false; } };
}
