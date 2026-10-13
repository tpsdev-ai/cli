/**
 * flair-task-loop.ts — Polls OrgEventCatchup for task.assigned events
 * targeting this agent. Runtime-agnostic: works without OpenClaw.
 *
 * The loop reads the catch-up feed through `FlairClient.getEventsSince`, which
 * returns the validated envelope read from org-event-read.ts (cli#619). It
 * advances its cursor from the feed's position (Flair's `after` cursor), not
 * from an event timestamp, and persists that position in
 * `~/.tps/cursors/<agentId>-task-loop.json` as `{ position, updatedAt }`,
 * resuming from it on restart. The file is replaced atomically (a temporary
 * file in the same directory, fsynced, then renamed over it). A legacy
 * `{ since }` file resumes from that timestamp; a file that cannot be read or
 * parsed is logged and treated as no cursor, so the first read looks back
 * FIRST_BOOT_LOOKBACK_MS.
 *
 * Events are handled in feed order. When a handler throws, the loop stops at
 * that event: the event stays eligible (it is not marked seen), the cursor is
 * persisted no further than the event before it, and the next poll, in this
 * process or after a restart, retries it before any later event.
 *
 * DELIVERY IS AT LEAST ONCE, not exactly once. The cursor is written once per
 * read, after its handlers run, so a crash after a handler returns and before
 * that write replays the event (and any other handled in the same read) on
 * restart. Handlers must be idempotent.
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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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
  /** The event's feed position (`<createdAt>\t<id>`). */
  position?: string;
}

export type TaskHandler = (event: OrgEvent) => Promise<void>;

const DEFAULT_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
/** How far back the first read looks when no cursor has been persisted yet. */
const FIRST_BOOT_LOOKBACK_MS = 3_600_000;
const LOOKBACK_NOTE = `the first read looks back ${FIRST_BOOT_LOOKBACK_MS / 60_000} minutes`;

function cursorDir(): string {
  return join(homeDir(), ".tps", "cursors");
}

/** The task loop's cursor file for `agentId`. */
export function taskLoopCursorPath(agentId: string): string {
  return join(cursorDir(), `${agentId}-task-loop.json`);
}

/**
 * The createdAt a feed position starts with (`<createdAt>\t<id>`; a position
 * with no tab is all timestamp, as Flair reads it), or null when that is not a
 * parseable date.
 */
export function positionTimestamp(position: string): string | null {
  const sep = position.indexOf("\t");
  const ts = sep === -1 ? position : position.slice(0, sep);
  return ts !== "" && !Number.isNaN(Date.parse(ts)) ? ts : null;
}

/**
 * The resume position a cursor file holds: its `position`, or, for a legacy
 * `{ since }` file, the position just before that timestamp. Undefined when the
 * file holds neither.
 */
export function cursorFilePosition(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { position, since } = data as { position?: unknown; since?: unknown };
  if (typeof position === "string" && position !== "") return position;
  if (typeof since === "string" && !Number.isNaN(Date.parse(since))) return `${since}\t`;
  return undefined;
}

/** The persisted feed position (Flair's `after` cursor), or undefined when there is none to resume from. */
function loadCursor(agentId: string): string | undefined {
  const path = taskLoopCursorPath(agentId);
  if (!existsSync(path)) {
    slog(`[${agentId}] No task loop cursor at ${path}; ${LOOKBACK_NOTE}`);
    return undefined;
  }
  let position: string | undefined;
  let problem = "it holds no position";
  try {
    position = cursorFilePosition(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    problem = e instanceof SyntaxError ? "it is not JSON" : `it cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`;
  }
  if (position === undefined) {
    swarn(`[${agentId}] Task loop cursor at ${path} is unusable (${problem}); treating it as no cursor, so ${LOOKBACK_NOTE}`);
  }
  return position;
}

/** Replace the cursor file atomically: write a temporary file beside it, fsync it, rename it over the cursor. */
function saveCursor(agentId: string, position: string): void {
  const path = taskLoopCursorPath(agentId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(cursorDir(), { recursive: true });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify({ position, updatedAt: new Date().toISOString() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    const err = e as Error;
    swarn(`[${agentId}] Failed to persist cursor: ${err.message}`);
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

/** The `since` floor for a read resuming at `position`: its createdAt, or the first-boot lookback. */
function cursorSince(position: string | undefined): Date {
  const ts = position ? positionTimestamp(position) : null;
  return ts ? new Date(ts) : new Date(Date.now() - FIRST_BOOT_LOOKBACK_MS);
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
          // Walk the read in feed order. `resumeAt` is the furthest position up to
          // which every event is done (handled, already seen, or not a task for
          // this agent); a handler failure stops the walk there.
          let resumeAt = position;
          let failed = false;
          for (const event of read.events) {
            if (!seen.has(event.id)) {
              const targets = event.targetIds ?? [];
              if (kinds.has(event.kind) && (targets.length === 0 || targets.includes(agentId))) {
                slog(`[${agentId}] Task received: ${event.kind} — ${event.summary}`);
                try {
                  await handler(event);
                } catch (e) {
                  const err = e as Error;
                  serror(`[${agentId}] Task handler error for ${event.id}: ${err.message}; it will be retried`);
                  failed = true;
                  break;
                }
              }
              // Marked seen only once done, so a failed event stays eligible.
              seen.add(event.id);
            }
            if (event.position) resumeAt = event.position;
          }
          // A drained read resumes at the feed's position; a failed one, no later
          // than the event before the failure.
          if (!failed && read.nextAfter) resumeAt = read.nextAfter;
          // A handler failure backs off like a failed read; a clean pass resets it.
          consecutiveErrors = failed ? consecutiveErrors + 1 : 0;

          if (resumeAt && resumeAt !== position) {
            position = resumeAt;
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
