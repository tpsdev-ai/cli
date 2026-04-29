// Watcher core logic
import { spawn } from "node:child_process";
import { readdir, readFile, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import type { MailMessage, MailWatcher, WatchOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const POLL_INTERVAL_MS = 5000;

function getAgentPaths(inboxRoot: string, options: WatchOptions): {
  inboxNew: string;
  inboxCur: string;
  launcher: string;
  tpsVaultKey: string;
  tpsCli: string;
  agentId: string;
} {
  const agent = options.agent ?? "ember";
  const launcher = options.launcher ?? join(inboxRoot, "agents", agent, "bin", agent);
  const inboxNew = join(inboxRoot, ".tps", "mail", agent, "new");
  const inboxCur = join(inboxRoot, ".tps", "mail", agent, "cur");
  const tpsVaultKey = process.env.TPS_VAULT_KEY ?? "tps-rockit-2026";
  const tpsCli = "packages/cli/dist/bin/tps.js";
  
  return {
    inboxNew,
    inboxCur,
    launcher,
    tpsVaultKey,
    tpsCli,
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

  // Send reply via TPS mail CLI
  const send = spawn("bun", ["run", paths.tpsCli, "mail", "send", sender, reply], {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    cwd: join(inboxRoot, "ops", "tps"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sendCode = await new Promise<number>((r) => send.on("close", r));
  if (sendCode !== 0) {
    console.error(`[${new Date().toISOString()}] tps mail send failed with ${sendCode} for ${msgId}`);
  } else {
    console.log(`[${new Date().toISOString()}] replied to ${sender} (${reply.length} chars)`);
  }

  // Ack the original message
  const ack = spawn("bun", ["run", paths.tpsCli, "mail", "ack", msgId, paths.agentId], {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    cwd: join(inboxRoot, "ops", "tps"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ackCode = await new Promise<number>((r) => ack.on("close", r));
  if (ackCode !== 0) {
    console.error(`[${new Date().toISOString()}] tps mail ack failed with ${ackCode} for ${msgId}`);
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
