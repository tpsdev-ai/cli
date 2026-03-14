/**
 * mail-watch — watch an agent's inbox for new messages and run exec hooks.
 *
 * OPS-121: event-driven mail watcher using fs.watch + debounce.
 * Zero CPU overhead when idle — no polling.
 *
 * Security mitigations (K&S):
 * - exec hooks use args[] array, no shell interpolation
 * - agent IDs validated: ^[a-zA-Z0-9._-]+$
 * - ENOENT grace on metadata read (file may move to cur/ before read)
 * - max 3 concurrent handlers
 */

import { existsSync, readdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getInbox } from "../utils/mail.js";
import type { MailMessage } from "../utils/mail.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchExecHook {
  /** Command + args — no shell interpolation. */
  args: string[];
  /** Environment variables to set for the hook process. */
  env?: Record<string, string>;
}

export interface MailWatchOptions {
  /** Agent ID to watch. Must match ^[a-zA-Z0-9._-]+$ */
  agent: string;
  /** Debounce window in ms — coalesces rapid fs events (default: 50) */
  debounceMs?: number;
  /** Exec hook to run on each new message. */
  hook?: WatchExecHook;
  /** Called for each new message. */
  onMessage?: (msg: MailMessage) => void | Promise<void>;
  /** Max concurrent handlers (default: 3) */
  maxConcurrent?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-zA-Z0-9._-]+$/;

export function validateAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agent ID: ${JSON.stringify(agentId)}. Must match ^[a-zA-Z0-9._-]+$`
    );
  }
}

// ---------------------------------------------------------------------------
// Message reading (ENOENT-safe)
// ---------------------------------------------------------------------------

function readMessageSafe(filePath: string): MailMessage | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as MailMessage;
  } catch (err: unknown) {
    // ENOENT: file moved to cur/ between readdir and read — expected race
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function listNewFiles(freshDir: string): string[] {
  if (!existsSync(freshDir)) return [];
  try {
    return readdirSync(freshDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(freshDir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exec hook runner
// ---------------------------------------------------------------------------

/**
 * Run a hook for a single message.
 * Passes message metadata via env vars; body via stdin.
 * No shell interpolation — args passed directly to spawn().
 */
function runHook(hook: WatchExecHook, msg: MailMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!hook.args.length) { resolve(); return; }

    const child = spawn(hook.args[0]!, hook.args.slice(1), {
      env: {
        ...process.env,
        ...(hook.env ?? {}),
        TPS_MAIL_ID: msg.id,
        TPS_MAIL_FROM: msg.from,
        TPS_MAIL_TO: msg.to,
        TPS_MAIL_TIMESTAMP: msg.timestamp,
      },
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.stdin.write(msg.body, "utf-8");
    child.stdin.end();

    child.on("exit", () => resolve());
    child.on("error", () => resolve()); // hook errors don't crash the watcher
  });
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface MailWatcher {
  stop(): void;
}

/**
 * Watch an agent's inbox for new messages using fs.watch + debounce.
 * Zero CPU overhead when idle. Returns a handle with stop() to cancel.
 */
export function watchMail(opts: MailWatchOptions): MailWatcher {
  validateAgentId(opts.agent);

  const debounceMs = opts.debounceMs ?? 50;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  let stopped = false;
  let activeHandlers = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Set<string>();

  const inbox = getInbox(opts.agent);

  // Pre-populate seen with already-present files so we don't replay old mail
  for (const f of listNewFiles(inbox.fresh)) {
    seen.add(f);
  }

  const processNew = async () => {
    if (stopped) return;
    for (const filePath of listNewFiles(inbox.fresh)) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      const msg = readMessageSafe(filePath);
      if (!msg) continue; // moved to cur/ before we could read — skip

      if (activeHandlers >= maxConcurrent) continue; // drop when at limit
      activeHandlers++;

      (async () => {
        try {
          if (opts.onMessage) await opts.onMessage(msg);
        } catch { /* callback errors don't crash the watcher */ }
        try {
          if (opts.hook) await runHook(opts.hook, msg);
        } catch { /* hook errors don't crash the watcher */ }
      })().finally(() => { activeHandlers--; });
    }
  };

  const onFsEvent = () => {
    if (stopped) return;
    // Debounce: coalesce rapid rename/create events
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void processNew(); }, debounceMs);
  };

  // fs.watch on the new/ directory — fires on file create/rename
  const watcher = fsWatch(inbox.fresh, onFsEvent);

  return {
    stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      try { watcher.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface MailWatchArgs {
  agent: string;
  hook?: string[];       // exec hook args from CLI
  debounce?: number;     // debounce window in ms
  json?: boolean;        // output messages as JSON
  interval?: number;     // kept for back-compat, unused (was polling interval)
}

export async function runMailWatch(args: MailWatchArgs): Promise<void> {
  validateAgentId(args.agent);

  const hook: WatchExecHook | undefined = args.hook?.length
    ? { args: args.hook }
    : undefined;

  const watcher = watchMail({
    agent: args.agent,
    debounceMs: args.debounce,
    hook,
    maxConcurrent: 3,
    onMessage: (msg) => {
      if (args.json) {
        console.log(JSON.stringify(msg));
      } else {
        console.log(`📬 ${msg.from} → ${msg.to}  ${msg.timestamp}`);
        console.log(msg.body);
        console.log("---");
      }
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise<void>(() => {});
}
