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

function buildPlist(agent: string, tpsBin: string, extraHookArgs: string[]): string {
  const label = plistLabel(agent);
  const stdout = join(logDir(), `mail-watch-${agent}.log`);
  const stderr = join(logDir(), `mail-watch-${agent}.error.log`);

  const hookArgs = extraHookArgs.map((a) => `    <string>${a}</string>`).join("\n");

  // Build ProgramArguments array
  const progArgs = [
    `    <string>${process.execPath}</string>`,
    `    <string>${tpsBin}</string>`,
    `    <string>mail</string>`,
    `    <string>watch</string>`,
    `    <string>${agent}</string>`,
    ...(extraHookArgs.length ? [`    <string>--exec</string>`, hookArgs] : []),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

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

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${stdout}</string>

  <key>StandardErrorPath</key>
  <string>${stderr}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
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
