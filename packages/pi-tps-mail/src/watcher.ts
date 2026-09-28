// Watcher core logic
import { spawn } from "node:child_process";
import { readdir, readFile, rename } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

import type { MailMessage, MailWatcher, WatchOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const POLL_INTERVAL_MS = 5000;
const RETRY_BACKOFF_MS = 60_000; // first retry of a failed reply send
const RETRY_BACKOFF_MAX_MS = 1_800_000; // backoff cap (30 minutes)

const VALID_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * The signed-envelope id rule `tps mail send --reply-to` enforces (and every
 * receipt enforces) — packages/cli/src/utils/envelope-id.ts. Mirrored here so
 * the watcher never hands the CLI an id it would refuse: an unthreadable
 * inbound gets an unthreaded (still signed) reply instead of a send that can
 * never succeed.
 */
const ENVELOPE_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * cli#429: the SIGNED `messageId` of an inbound — the durable thread id a reply
 * carries in `--reply-to`. The local record `id` is not it (a branch
 * regenerates it on delivery); the id lives in the signed envelope the record's
 * body carries. Null when the body is not an envelope or its id is outside the
 * rule. The watcher does not verify the envelope itself (it reads new/
 * directly); the id is the one the inbound's envelope carries.
 */
function inboundThreadId(body: string): string | null {
  try {
    const env = JSON.parse(body) as { messageId?: unknown } | null;
    const id = env?.messageId;
    return typeof id === "string" && ENVELOPE_ID_SHAPE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * A reply whose send FAILED: the inbound was put back in new/ and is retried
 * after `nextAttemptAt` with the SAME reply text (the launcher is not re-run for
 * a send failure). In memory: a restart re-dispatches the inbound from new/
 * (at-least-once).
 */
interface PendingReply {
  reply: string;
  nextAttemptAt: number;
  backoffMs: number;
}
type RetryState = Map<string, PendingReply>;

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

/**
 * Send the reply through `tps mail send` as the agent — the BODY ON STDIN (never
 * argv) and `--reply-to` the inbound's signed messageId when it has one
 * (cli#429). The CLI signs with the agent's key and REFUSES (non-zero, nothing
 * written) when it cannot. Resolves to the exit code; stderr is captured so a
 * refusal is logged with the CLI's own reason (key paths + remedy).
 */
async function sendReply(
  paths: ReturnType<typeof getAgentPaths>,
  sender: string,
  reply: string,
  threadId: string | null,
): Promise<{ code: number; timedOut: boolean; stderr: string }> {
  const args = ["mail", "send", sender, "--stdin", ...(threadId ? ["--reply-to", threadId] : [])];
  const send = spawn(paths.tpsBin, args, {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  send.stderr.setEncoding("utf8");
  send.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
  send.stdout.resume();
  // A child that exits before reading stdin makes the write fail (EPIPE): that
  // is a failed send, reported by the exit code — never an uncaught error.
  send.stdin.on("error", () => {});
  send.stdin.end(reply, "utf8");

  let timedOut = false;
  const sendTimer = setTimeout(() => {
    timedOut = true;
    console.error(`[${new Date().toISOString()}] tps mail send TIMEOUT — killing pid ${send.pid}`);
    try { send.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { send.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, 5_000);
  sendTimer.unref();

  const code = await new Promise<number>((r) => send.on("close", (c) => r(c ?? 1)));
  clearTimeout(sendTimer);
  return { code, timedOut, stderr: stderr.trim() };
}

async function dispatchMessage(
  filePath: string,
  inboxRoot: string,
  options: WatchOptions,
  retries: RetryState,
): Promise<void> {
  const paths = getAgentPaths(inboxRoot, options);
  const id = basename(filePath);
  const pending = retries.get(id);
  if (pending && Date.now() < pending.nextAttemptAt) return; // backing off
  
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
  const threadId = inboundThreadId(body);

  console.log(`[${new Date().toISOString()}] ${pending ? "retrying the reply to" : "dispatching"} ${msgId} from ${sender}`);

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

  // A retry after a failed SEND re-sends the reply already produced; the
  // launcher is not re-run for a send failure.
  const reply = pending ? pending.reply : await runLauncher(paths, inboxRoot, options, body, msgId);

  // Send the reply: body on stdin, threaded to the inbound's signed messageId.
  const sent = await sendReply(paths, sender, reply, threadId);
  if (sent.code !== 0) {
    // cli#429: a failed send is NOT acknowledged. The inbound goes back to new/
    // so it is retried — with this same reply, after a backoff (no hot loop,
    // no second launcher run) — until the send succeeds.
    const backoffMs = pending
      ? Math.min(pending.backoffMs * 2, RETRY_BACKOFF_MAX_MS)
      : (options.retryBackoffMs ?? RETRY_BACKOFF_MS);
    console.error(
      `[${new Date().toISOString()}] tps mail send failed with ${sent.code} for ${msgId}${sent.timedOut ? " (timed out)" : ""}` +
        `${sent.stderr ? `: ${sent.stderr}` : ""} — NOT acknowledged; retrying in ${backoffMs}ms`,
    );
    try {
      await rename(curPath, filePath);
      retries.set(id, { reply, nextAttemptAt: Date.now() + backoffMs, backoffMs });
    } catch (err: unknown) {
      console.error(
        `[${new Date().toISOString()}] could not return ${id} to new/ for retry: ${(err as Error).message}; it stays in cur/ unacknowledged`,
      );
      retries.delete(id);
    }
    return;
  }
  retries.delete(id);
  console.log(`[${new Date().toISOString()}] replied to ${sender} (${reply.length} chars${threadId ? `, reply-to ${threadId}` : ", unthreaded"})`);

  // Ack the original message ONLY now that the reply was sent.
  const ack = spawn(paths.tpsBin, ["mail", "ack", msgId, paths.agentId], {
    env: { ...process.env, TPS_VAULT_KEY: paths.tpsVaultKey, TPS_AGENT_ID: paths.agentId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ack.stdout.resume();
  ack.stderr.resume();

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

/** Run the agent launcher on the inbound body; resolves to the reply text. */
async function runLauncher(
  paths: ReturnType<typeof getAgentPaths>,
  inboxRoot: string,
  options: WatchOptions,
  body: string,
  msgId: string,
): Promise<string> {
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

  return timedOut
    ? `(launcher dispatch timed out after ${timeoutMs}ms — partial stdout ${stdout.length}B, stderr: ${stderr.slice(0, 500)})`
    : (stdout.trim() || `(no output, stderr: ${stderr.slice(0, 500)})`);
}

async function pollInbox(inboxRoot: string, options: WatchOptions, retries: RetryState): Promise<void> {
  const paths = getAgentPaths(inboxRoot, options);
  
  try {
    const files = await readdir(paths.inboxNew);
    for (const f of files) {
      if (f.startsWith(".")) continue;
      try {
        await dispatchMessage(join(paths.inboxNew, f), inboxRoot, options, retries);
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
  const retries: RetryState = new Map();
  
  const processMsg = async () => {
    if (stopped) return;
    await pollInbox(inboxRoot, options, retries);
    
    if (!stopped) {
      setTimeout(processMsg, options.pollIntervalMs ?? POLL_INTERVAL_MS);
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
