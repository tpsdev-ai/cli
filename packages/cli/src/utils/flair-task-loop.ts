/**
 * flair-task-loop.ts — Polls OrgEventCatchup for task.assigned events
 * targeting this agent. Runtime-agnostic: works without OpenClaw.
 *
 * CURSOR. The loop reads `agentId`'s catch-up feed through
 * `FlairClient.getEventsSince` (the validated reader in org-event-read.ts,
 * cli#619), always sending its position as Flair's `after` cursor, so Flair's
 * own watermark for the agent never chooses where reading starts. The position
 * is persisted in `~/.tps/cursors/<loopId>-task-loop.json` as
 * `{ position, updatedAt }` and replaced atomically (a temporary file in the
 * same directory, fsynced, then renamed over it). The task and review loops use
 * different cursor filenames; callers that omit `loopId` use the `agentId` cursor. It must
 * be a single safe filename component (see `LOOP_ID_PATTERN`); `startTaskLoop` refuses any other with
 * `InvalidLoopIdError` before reading or writing a cursor. With no usable cursor file, the loop sets the position to
 * FIRST_BOOT_LOOKBACK_MS before now, once, and does not read the feed until
 * that position is saved: a failed save is logged by name and retried with
 * backoff, with the same position, and `stop()` ends the retrying. A legacy
 * `{ since }` file resumes just before that timestamp; a file that cannot be
 * read or parsed is logged and treated as no cursor.
 *
 * ADVANCING. Events are processed in feed order. A task passed to the handler is
 * marked seen only after the handler succeeds; an event that is not a task for
 * this agent is marked seen without one. The persisted position advances only
 * over events that are done, and stops:
 *   - at a handler failure: the next successful read, in this process or after
 *     a restart that finds the cursor file intact, retries the failed event
 *     before any later one;
 *   - before a position later than the server's time plus MAX_POSITION_SKEW_MS
 *     (the time from the response's `Date` header, or this host's clock when it
 *     has no valid one). Such an event is still passed to the handler if it is
 *     a task, and since the persisted position stays before it, events
 *     positioned between the two still arrive.
 * An unavailable read, including a page that fails validation, is logged with
 * its bounded reason and backs off without handling or persisting anything.
 *
 * The position is saved after a read's handlers run, when it advances. A
 * failed save there is logged and the loop goes on from the position in
 * memory, so the saved position stays behind it until a later save succeeds; a
 * restart before that replays the events in between rather than skipping them.
 *
 * SAFETY. The saved position never passes a task before its handler succeeds,
 * provided that once saved, the cursor file is not removed or corrupted; the
 * feed only appends (a new event sorts after those already served), with
 * positions within MAX_POSITION_SKEW_MS of the server's time; and an event does
 * not expire before its handler succeeds.
 *
 * DELIVERY (liveness) also needs the loop to keep running; its reads (pages
 * that pass validation) and the initial save to succeed eventually; and the
 * handler to eventually return successfully for each earlier task, since a
 * handler that keeps failing holds the loop at that task on every read. Under
 * all of these, each task after the starting position is handled (its handler
 * returns successfully) at least once, not exactly once: a crash between a
 * handler returning and the save that follows replays that task, as does a
 * restart after a failed save if it occurs before a later successful save.
 * Handlers must be idempotent.
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
/** How far back the initial position is set when there is no usable cursor. */
const FIRST_BOOT_LOOKBACK_MS = 3_600_000;
const LOOKBACK_NOTE = `the initial position is set ${FIRST_BOOT_LOOKBACK_MS / 60_000} minutes back`;
/** How far past the server's time a position may be and still be persisted. */
export const MAX_POSITION_SKEW_MS = 5 * 60_000;

function cursorDir(): string {
  return join(homeDir(), ".tps", "cursors");
}

/**
 * The allowed set for `loopId`: a single filename component of 1..79 characters
 * from `A-Z a-z 0-9 . _ -`, excluding the two dot components `.` and `..`. It
 * names the cursor file `<loopId>-task-loop.json` inside the cursors directory,
 * so a path separator, a NUL, an empty or over-long string, or `.`/`..` is
 * refused rather than allowed to resolve a cursor outside that directory.
 */
const LOOP_ID_PATTERN = /^[A-Za-z0-9._-]{1,79}$/;

/** Whether `loopId` is a single safe filename component (see `LOOP_ID_PATTERN`). */
export function isSafeLoopId(loopId: string): boolean {
  return LOOP_ID_PATTERN.test(loopId) && loopId !== "." && loopId !== "..";
}

/** Thrown by `startTaskLoop` for a `loopId` that is not a single safe filename component. */
export class InvalidLoopIdError extends Error {
  constructor(loopId: string) {
    super(`Invalid loopId ${JSON.stringify(loopId)}: it must be a single filename component matching ${LOOP_ID_PATTERN} and not "." or ".."`);
    this.name = "InvalidLoopIdError";
  }
}

/** The loop's cursor file for `loopId`. */
export function taskLoopCursorPath(loopId: string): string {
  return join(cursorDir(), `${loopId}-task-loop.json`);
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
 * The resume position a cursor file holds: its `position` (when that starts
 * with a parseable timestamp), or, for a legacy `{ since }` file, the position
 * just before that timestamp. Undefined when the file holds neither.
 */
export function cursorFilePosition(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { position, since } = data as { position?: unknown; since?: unknown };
  if (typeof position === "string" && positionTimestamp(position) !== null) return position;
  if (typeof since === "string" && !Number.isNaN(Date.parse(since))) return `${since}\t`;
  return undefined;
}

/** The persisted feed position (Flair's `after` cursor), or undefined when there is none to resume from. */
function loadCursor(loopId: string): string | undefined {
  const path = taskLoopCursorPath(loopId);
  if (!existsSync(path)) {
    slog(`[${loopId}] No task loop cursor at ${path}; ${LOOKBACK_NOTE}`);
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
    swarn(`[${loopId}] Task loop cursor at ${path} is unusable (${problem}); treating it as no cursor, so ${LOOKBACK_NOTE}`);
  }
  return position;
}

/**
 * Replace the cursor file atomically: write a temporary file beside it, fsync
 * it, rename it over the cursor. Returns undefined on success, or the failure's
 * name (its code, such as EACCES, or its class) for the caller to log.
 */
function saveCursor(loopId: string, position: string): string | undefined {
  const path = taskLoopCursorPath(loopId);
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
    return undefined;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    return (e as NodeJS.ErrnoException).code ?? (e as Error).name;
  }
}

/** The initial position: FIRST_BOOT_LOOKBACK_MS before now, just before any event at that instant. */
function initialPosition(): string {
  return `${new Date(Date.now() - FIRST_BOOT_LOOKBACK_MS).toISOString()}\t`;
}

/**
 * The `since` floor for a read after `position`: the position's own timestamp,
 * so the floor moves only when the position does. Every position the loop
 * holds has a parseable timestamp (`cursorFilePosition`, `initialPosition`, and
 * the reader's position checks); the epoch fallback only leaves `after` to
 * decide.
 */
function cursorSince(position: string): Date {
  const ts = positionTimestamp(position);
  return ts ? new Date(ts) : new Date(0);
}

export function startTaskLoop(
  flair: FlairClient,
  agentId: string,
  handler: TaskHandler,
  opts: { pollIntervalMs?: number; kinds?: string[]; loopId?: string } = {},
): { stop: () => Promise<void> } {
  const basePollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const kinds = new Set(opts.kinds ?? ["task.assigned"]);
  // Omitted loop IDs use the agentId cursor.
  const loopId = opts.loopId ?? agentId;
  // Refuse an unsafe loopId before any cursor is read or written: it names the
  // cursor file, so one with a path separator or a traversal segment could
  // resolve a cursor outside the cursors directory.
  if (!isSafeLoopId(loopId)) throw new InvalidLoopIdError(loopId);
  const loaded = loadCursor(loopId);
  // A new initial position is computed once, here; saving it is retried with
  // this same value until it succeeds, and the feed is not read before then.
  let position: string = loaded ?? initialPosition();
  let running = true;
  let wake: (() => void) | undefined;
  let heldAt: string | undefined;
  let consecutiveErrors = 0;
  const seen = new Set<string>();

  /** Wait `delay` ms, or until `stop` is called. */
  async function sleep(delay: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    wake = undefined;
  }

  /** Save the initial position, retrying with backoff; false when stopped first. */
  async function saveInitialPosition(): Promise<boolean> {
    for (let attempt = 1; running; attempt++) {
      const failure = saveCursor(loopId, position);
      if (failure === undefined) return true;
      const delay = Math.min(basePollMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      swarn(
        `[${loopId}] Task loop cannot save its initial position to ${taskLoopCursorPath(loopId)} (${failure}); ` +
          `the feed is not read until it is saved; retrying in ${delay} ms`,
      );
      await sleep(delay);
    }
    return false;
  }

  async function poll() {
    if (loaded === undefined && !(await saveInitialPosition())) return;
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
          // this agent) and not past the time limit; a handler failure stops the
          // walk there, and a position past the limit holds it.
          const limitMs = (read.serverTime ? Date.parse(read.serverTime) : Date.now()) + MAX_POSITION_SKEW_MS;
          const withinLimit = (p: string) => {
            const ts = positionTimestamp(p);
            return ts !== null && Date.parse(ts) <= limitMs;
          };
          let resumeAt = position;
          let failed = false;
          let held: OrgEvent | undefined;
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
            if (held === undefined && event.position) {
              if (withinLimit(event.position)) resumeAt = event.position;
              else held = event;
            }
          }
          // A drained read resumes at the feed's position; a failed or held one
          // stays where the walk stopped.
          if (!failed && held === undefined && read.nextAfter && withinLimit(read.nextAfter)) resumeAt = read.nextAfter;
          if (held !== undefined && held.position !== heldAt) {
            heldAt = held.position;
            swarn(
              `[${agentId}] Task loop cursor held before ${held.id}: its position is later than the server's time plus ${MAX_POSITION_SKEW_MS / 60_000} minutes`,
            );
          }
          // A handler failure backs off like a failed read; a clean pass resets it.
          consecutiveErrors = failed ? consecutiveErrors + 1 : 0;

          if (resumeAt !== position) {
            position = resumeAt;
            // A failed save is logged and the loop goes on from the position in
            // memory. The saved position is then behind it, so a restart replays
            // events rather than skipping them.
            const failure = saveCursor(loopId, position);
            if (failure !== undefined) swarn(`[${loopId}] Failed to persist cursor to ${taskLoopCursorPath(loopId)} (${failure})`);
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
      if (!running) break;
      await sleep(delay);
    }
  }

  const done = poll();
  slog(`[${agentId}] Task loop started (polling every ${basePollMs / 1000}s, position: ${position})`);
  // `stop` ends the wait between polls and resolves once the loop has exited, so
  // nothing the loop does (a read, a handler, a cursor write) runs after it.
  return {
    stop: () => {
      running = false;
      wake?.();
      return done;
    },
  };
}
