/**
 * mail-watch — watch an agent's inbox for new messages and run exec hooks.
 *
 * OPS-121: mail watcher using fs.watch + debounce for low-latency delivery,
 * backed by a low-frequency poll fallback. fs.watch (FSEvents on macOS) goes
 * deaf after uptime, so it can't be the sole trigger — the poll guarantees
 * delivery and lets a (re)start recover any mail stranded in new/. Near-zero
 * idle CPU; reliability over strictly-zero-CPU.
 *
 * Security mitigations (K&S):
 * - exec hooks use args[] array, no shell interpolation
 * - agent IDs validated: ^[a-zA-Z0-9._-]+$
 * - ENOENT grace on metadata read (file may move to cur/ before read)
 * - max 3 concurrent handlers
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch as fsWatch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  /** Polling-fallback interval in ms — guards against fs.watch going deaf (default: 15000) */
  pollMs?: number;
  /**
   * Liveness heartbeat fired once per poll cycle (ops-i3vw — Flair Presence dogfood).
   * Binding the heartbeat to the SAME poll loop that delivers mail means a stalled
   * or dead watcher stops beating — so its Presence record goes stale and the
   * staleness monitor flags it. This directly catches the 2026-06-25 failure
   * (a watcher stalled 13h with nothing recording its liveness). Errors are
   * swallowed: a heartbeat failure must never crash the mail loop.
   */
  onPoll?: () => void | Promise<void>;
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
    // JSON parse error: corrupt file — log and skip instead of crashing
    if (err instanceof SyntaxError) {
      console.error(`[mail-watch] skipping corrupt message ${filePath}: ${err.message}`);
      return null;
    }
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

  // NOTE: we intentionally do NOT pre-populate `seen` with files already in
  // new/. new/ holds UNDELIVERED mail — the exec hook moves delivered mail to
  // cur/ on ack — so anything present at (re)start must be delivered. Marking
  // it seen on boot is what made a mail-watch kickstart silently strand stuck
  // dispatches (and forced re-dispatches, which double-posted K&S reviews).
  const processNew = async () => {
    if (stopped) return;
    for (const filePath of listNewFiles(inbox.fresh)) {
      if (seen.has(filePath)) continue;
      // Check the concurrency cap BEFORE marking seen. If we're at the limit,
      // leave the file UNSEEN so the next pass (poll or fs event) retries it.
      // The old order marked it seen and THEN dropped it → never delivered.
      if (activeHandlers >= maxConcurrent) continue;
      seen.add(filePath);

      const msg = readMessageSafe(filePath);
      if (!msg) continue; // moved to cur/ before we could read — skip
      activeHandlers++;

      (async () => {
        try {
          if (opts.onMessage) await opts.onMessage(msg);
        } catch { /* callback errors don't crash the watcher */ }
        try {
          if (opts.hook) await runHook(opts.hook, msg);
        } catch { /* hook errors don't crash the watcher */ }
      })().finally(() => {
        activeHandlers--;
        // A slot just freed — immediately re-check for mail that was over the
        // concurrency cap on a prior pass, so a burst drains as slots cycle
        // instead of waiting for the next fs event or poll.
        if (!stopped) void processNew();
      });
    }
  };

  const onFsEvent = () => {
    if (stopped) return;
    // Debounce: coalesce rapid rename/create events
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void processNew(); }, debounceMs);
  };

  // fs.watch on new/ fires on file create/rename — low-latency, but fs.watch
  // (FSEvents on macOS) silently stops emitting after uptime, which strands
  // mail. So treat fs.watch as a latency optimization, NOT the source of truth:
  // a low-frequency poll guarantees delivery even if the watcher goes deaf.
  // Reliability > idle CPU for the review/mail pipeline.
  const watcher = fsWatch(inbox.fresh, onFsEvent);
  const pollMs = opts.pollMs ?? 15_000;

  // Liveness heartbeat — fire once per GUARANTEED poll cycle (not the fs-event
  // path, which can go deaf). A heartbeat error never propagates: it must not
  // crash the mail loop. If the watcher stalls/dies, the heartbeat stops with
  // it → Presence goes stale → the staleness monitor flags it. (ops-i3vw)
  const beat = () => {
    if (stopped || !opts.onPoll) return;
    Promise.resolve()
      .then(() => opts.onPoll!())
      .catch(() => { /* heartbeat failure must not crash the watcher */ });
  };

  const pollTimer = setInterval(() => { void processNew(); beat(); }, pollMs);

  // Deliver anything already waiting in new/ at (re)start, immediately — so a
  // kickstart RECOVERS stuck mail instead of waiting for the first event/poll.
  void processNew();
  // Beat once at startup so a fresh (re)start registers liveness immediately.
  beat();

  return {
    stop() {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      try { watcher.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon (launchd on macOS, nohup on Linux)
// ---------------------------------------------------------------------------

const PLIST_LABEL_PREFIX = "ai.tpsdev.mail-watch";

function plistLabel(agent: string): string {
  return `${PLIST_LABEL_PREFIX}.${agent}`;
}

function plistPath(agent: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${plistLabel(agent)}.plist`);
}

function logDir(): string {
  const dir = join(homedir(), ".tps", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Escape a string for safe embedding inside a plist XML <string> element. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the launchd plist for an agent's mail-watch daemon.
 * Exported for unit testing (asserts ProcessType=Background + valid XML).
 */
export function buildPlist(agent: string, tpsBin: string, extraHookArgs: string[]): string {
  const label = plistLabel(agent);
  const stdout = join(logDir(), `mail-watch-${agent}.log`);
  const stderr = join(logDir(), `mail-watch-${agent}.error.log`);

  // XML-escape all args before embedding in plist
  const hookArgs = extraHookArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  // Build ProgramArguments array — escape paths too (handles spaces, &, etc.)
  const progArgs = [
    `    <string>${xmlEscape(process.execPath)}</string>`,
    `    <string>${xmlEscape(tpsBin)}</string>`,
    `    <string>mail</string>`,
    `    <string>watch</string>`,
    `    <string>${xmlEscape(agent)}</string>`,
    ...(extraHookArgs.length ? [`    <string>--exec</string>`, hookArgs] : []),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>

  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>

  <!--
    ProcessType=Background tells launchd this is a long-lived background daemon.
    Without it, the watcher's idle poll timer (waking every ~15s) gets the job
    power-classified as "inefficient" and macOS reaps it with a clean exit 0 —
    which KeepAlive(Crashed:true) does NOT restart, so the agent goes silently
    deaf. Background processing type opts the job out of that idle-reap. (ops-bayh)
  -->
  <key>ProcessType</key>
  <string>Background</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

export function installDaemon(agent: string, hookArgs: string[] = []): void {
  validateAgentId(agent); // validate before platform check
  if (platform() !== "darwin") {
    throw new Error("--daemon install is only supported on macOS (launchd). On Linux, use a supervisor or nohup manually.");
  }

  const tpsBin = resolve(fileURLToPath(import.meta.url), "../../bin/tps.js");
  const plist = buildPlist(agent, tpsBin, hookArgs);
  const path = plistPath(agent);
  const label = plistLabel(agent);

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, plist, "utf-8");

  // Unload if already loaded, then load fresh
  try { execSync(`launchctl unload "${path}" 2>/dev/null`, { stdio: "ignore" }); } catch {}
  execSync(`launchctl load "${path}"`, { stdio: "inherit" });

  console.log(`✅ mail-watch daemon installed and started (${label})`);
  console.log(`   Log: ${join(logDir(), `mail-watch-${agent}.log`)}`);
  console.log(`   Plist: ${path}`);
}

export function uninstallDaemon(agent: string): void {
  validateAgentId(agent); // validate before platform check
  if (platform() !== "darwin") {
    throw new Error("--daemon uninstall is only supported on macOS (launchd).");
  }

  const path = plistPath(agent);
  if (!existsSync(path)) {
    console.log(`No daemon installed for agent: ${agent}`);
    return;
  }

  try { execSync(`launchctl unload "${path}"`, { stdio: "ignore" }); } catch {}
  unlinkSync(path);
  console.log(`✅ mail-watch daemon uninstalled (${plistLabel(agent)})`);
}

export function daemonStatus(agent: string): void {
  validateAgentId(agent);
  const path = plistPath(agent);
  const label = plistLabel(agent);

  if (!existsSync(path)) {
    console.log(`mail-watch daemon: NOT INSTALLED (${label})`);
    return;
  }

  try {
    const out = execSync(`launchctl list | grep "${label}" 2>/dev/null`, { encoding: "utf-8" });
    if (out.trim()) {
      const parts = out.trim().split(/\s+/);
      const pid = parts[0] !== "-" ? `PID ${parts[0]}` : "not running";
      console.log(`mail-watch daemon: ✅ LOADED (${pid})`);
    } else {
      console.log(`mail-watch daemon: INSTALLED but NOT LOADED`);
    }
  } catch {
    console.log(`mail-watch daemon: INSTALLED but NOT LOADED`);
  }
  console.log(`   Plist: ${path}`);
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
  daemon?: string;       // "install" | "uninstall" | "status"
}

export async function runMailWatch(args: MailWatchArgs): Promise<void> {
  // Handle daemon subcommands
  if (args.daemon) {
    validateAgentId(args.agent);
    switch (args.daemon) {
      case "install":
        installDaemon(args.agent, args.hook ?? []);
        return;
      case "uninstall":
        uninstallDaemon(args.agent);
        return;
      case "status":
        daemonStatus(args.agent);
        return;
      default:
        console.error(`Unknown daemon action: ${args.daemon}. Use: install | uninstall | status`);
        process.exit(1);
    }
  }

  validateAgentId(args.agent);

  const hook: WatchExecHook | undefined = args.hook?.length
    ? { args: args.hook }
    : undefined;

  // Flair Presence heartbeat (ops-i3vw) — DEFAULT-OFF, byte-identical when off.
  // Enable per-agent by setting TPS_PRESENCE_BEAT_CMD to an executable that
  // emits the agent's Presence (it reads TPS_AGENT_ID / FLAIR_AGENT_ID). The
  // watcher fires it once per poll cycle; failures are swallowed inside watchMail.
  const beatCmd = process.env.TPS_PRESENCE_BEAT_CMD;
  const onPoll: (() => void) | undefined = beatCmd
    ? () => {
        // Fire-and-forget; never block or crash the mail loop. No shell interp.
        const child = spawn(beatCmd, [], {
          env: { ...process.env, FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID ?? args.agent, TPS_AGENT_ID: process.env.TPS_AGENT_ID ?? args.agent },
          stdio: "ignore",
        });
        child.on("error", () => { /* heartbeat failure must not crash the watcher */ });
      }
    : undefined;

  const watcher = watchMail({
    agent: args.agent,
    debounceMs: args.debounce,
    hook,
    maxConcurrent: 3,
    onPoll,
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
