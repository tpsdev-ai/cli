// Watcher core logic
import { spawn } from "node:child_process";
import { readdir, readFile, rename } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

import type { MailMessage, MailWatcher, WatchOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const POLL_INTERVAL_MS = 5000;

const VALID_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

function getAgentPaths(inboxRoot: string, options: WatchOptions): {
  inboxNew: string;
  inboxCur: string;
  launcher: string;
  tpsVaultKey: string;
  tpsBin: string;
  agentId: string;
} {
  const agent = options.agent ?? "ember";
  
  // Validate agent ID to prevent path traversal
  if (!VALID_AGENT_ID.test(agent)) {
    throw new Error(`Invalid agent ID: ${agent}`);
  }
  
  const launcher = options.launcher ?? join(inboxRoot, "agents", agent, "bin", agent);
  const inboxNew = join(inboxRoot, ".tps", "mail", agent, "new");
  const inboxCur = join(inboxRoot, ".tps", "mail", agent, "cur");
  
  // Require TPS_VAULT_KEY env var — no fallback credential
  const tpsVaultKey = process.env.TPS_VAULT_KEY;
  if (!tpsVaultKey) {
    throw new Error("TPS_VAULT_KEY is required");
  }
  
  // Use installed CLI on PATH, or env var override
  const tpsBin = process.env.TPS_BIN || "tps";
  
  return {
    inboxNew,
    inboxCur,
    launcher,
    tpsVaultKey,
    tpsBin,
    agentId: agent,
  };
}

async function dispatchMessage(
  filePath: string,
  inboxRoot: string,
  options: WatchOptions
): Promise<void> {
  const paths = getAgentPaths(inboxRoot, options);
  const id = basename(filePath);
  
  // Parse message JSON
  let msg: MailMessage;
  try {
    const raw = await readFile(filePath, "utf8");
    msg = JSON.parse(raw) as MailMessage;
  } catch (err: unknown) {
    const msgId = (err instanceof SyntaxError) ? `parse error: ${err.message}` : `unknown error`;
    console.error(`[${new Date().toISOString()}] bad JSON in ${id}: ${msgId}`);
    return;
  }

  const sender = msg.from ?? "flint";
  const body = msg.body ?? "";
  const msgId = msg.id ?? id;

  console.log(`[${new Date().toISOString()}] dispatching ${msgId} from ${sender}`);

  // Move to cur/ before invoking (so we don't double-process)
  const curPath = join(paths.inboxCur, id);
  try {
    await rename(filePath, curPath);
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      console.log(`[${new Date().toISOString()}] ${id} already moved, skipping`);
      return;
    }
    if (errno === "EEXIST") {
      console.warn(`[${new Date().toISOString()}] ${id} already exists in cur/, skipping`);
      return;
    }
    throw err;
  }

  // Validate launcher path to prevent arbitrary exec
  const expectedDir = join(inboxRoot, "agents", paths.agentId, "bin");
  const resolvedLauncher = resolve(paths.launcher);
  const sep = "/";
  if (!resolvedLauncher.startsWith(expectedDir + sep) && resolvedLauncher !== expectedDir) {
    throw new Error(`Launcher must be within ${expectedDir}`);
  }

  // Delegate to the agent launcher — it owns provider/model selection
  // Launcher args: first any configured args, then the message body
  const launcherArgs = options.launcherArgs ?? [];
  const child = spawn(paths.launcher, [...launcherArgs, body], {
    env: process.env,
    cwd: join(inboxRoot, "agents", paths.agentId),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[${new Date().toISOString()}] launcher dispatch TIMEOUT after ${timeoutMs}ms for ${msgId} — killing pid ${child.pid}`);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, timeoutMs);
  timer.unref();

  const code = await new Promise<number>((r) => child.on("close", r));
  clearTimeout(timer);
  
  if (code !== 0) {
    console.error(`[${new Date().toISOString()}] launcher exited ${code} for ${msgId}${timedOut ? " (timed out)" : ""}`);
  }

  const reply = timedOut
    ? `(launcher dispatch timed out after ${timeoutMs}ms — partial stdout ${stdout.length}B, stderr: ${stderr.slice(0, 500)})`
    : (stdout.trim() || `(no output, stderr: ${stderr.slice(0, 500)})`);

  // Send reply via TPS mail CLI with timeout
  const send = spawn(paths.tpsBin, ["mail", "send", sender, reply], {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  
  let sendTimedOut = false;
  const sendTimer = setTimeout(() => {
    sendTimedOut = true;
    console.error(`[${new Date().toISOString()}] tps mail send TIMEOUT — killing pid ${send.pid}`);
    try { send.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { send.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, 5_000);
  sendTimer.unref();
  
  const sendCode = await new Promise<number>((r) => send.on("close", r));
  clearTimeout(sendTimer);
  if (sendCode !== 0) {
    console.error(`[${new Date().toISOString()}] tps mail send failed with ${sendCode} for ${msgId}${sendTimedOut ? " (timed out)" : ""}`);
  } else {
    console.log(`[${new Date().toISOString()}] replied to ${sender} (${reply.length} chars)`);
  }

  // Ack the original message with timeout
  const ack = spawn(paths.tpsBin, ["mail", "ack", msgId, paths.agentId], {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  
  let ackTimedOut = false;
  const ackTimer = setTimeout(() => {
    ackTimedOut = true;
    console.error(`[${new Date().toISOString()}] tps mail ack TIMEOUT — killing pid ${ack.pid}`);
    try { ack.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { ack.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, 5_000);
  ackTimer.unref();
  
  const ackCode = await new Promise<number>((r) => ack.on("close", r));
  clearTimeout(ackTimer);
  if (ackCode !== 0) {
    console.error(`[${new Date().toISOString()}] tps mail ack failed with ${ackCode} for ${msgId}${ackTimedOut ? " (timed out)" : ""}`);
  } else {
    console.log(`[${new Date().toISOString()}] acked ${msgId}`);
  }
}

async function pollInbox(inboxRoot: string, options: WatchOptions): Promise<void> {
  const paths = getAgentPaths(inboxRoot, options);
  
  try {
    const files = await readdir(paths.inboxNew);
    for (const f of files) {
      if (f.startsWith(".")) continue;
      try {
        await dispatchMessage(join(paths.inboxNew, f), inboxRoot, options);
      } catch (err: unknown) {
        console.error(`[${new Date().toISOString()}] dispatch error on ${f}: ${(err as Error).message}`);
      }
    }
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      console.warn(`[${new Date().toISOString()}] inbox ${paths.inboxNew} missing; waiting`);
    } else {
      console.error(`[${new Date().toISOString()}] poll error: ${(err as Error).message}`);
    }
  }
}

export function watchMail(options: WatchOptions = {}): MailWatcher {
  const inboxRoot = options.inboxRoot ?? homedir();
  const paths = getAgentPaths(inboxRoot, options);
  console.log(`pi-tps-mail watcher starting for agent=${paths.agentId}, inbox=${paths.inboxNew}`);

  let stopped = false;
  
  const processMsg = async () => {
    if (stopped) return;
    await pollInbox(inboxRoot, options);
    
    if (!stopped) {
      setTimeout(processMsg, POLL_INTERVAL_MS);
    }
  };

  // Start polling
  processMsg();

  return {
    stop() {
      stopped = true;
      console.log("pi-tps-mail watcher stopped.");
    },
  };
}
