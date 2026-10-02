// Watcher core logic
//
// cli#429 — THE INBOUND IS VERIFIED BEFORE ANY FIELD OF IT IS USED. The watcher
// never reads new/ as mail. Each check runs `tps mail check <agent> --json` as
// the agent: the CLI's own promotion path (promote()) verifies every new/
// record — signature, sender binding, recipient, replay, id shape — moves it to
// cur/, and dead-letters what fails; it also re-verifies and re-presents a
// cur/ record whose processing lease expired without an ack. The watcher acts
// ONLY on the verified records that command prints: the sender, the body the
// launcher sees and the thread the reply signs (the envelope's messageId) all
// come from the verified envelope. An unsigned or forged inbound is never
// dispatched and never answered.
//
// THE REPLY JOURNAL. Before a reply is first sent, the watcher writes it to
// `<mail>/<agent>/.pi-tps-mail/replies/<inbound id>.json` (0600): the verified
// sender and thread, the reply text, and the envelope messageId the reply is
// signed with. Every later step is driven from that entry:
//   - a send whose outcome is UNKNOWN (non-zero exit or timeout — the CLI may
//     have delivered before it failed) is re-sent after a backoff with the
//     SAME text, thread and envelope messageId (`--message-id`), never a new
//     launcher run: if the first attempt had in fact been delivered, the
//     recipient gets a second copy of the same message, which a
//     promote()-reading recipient dead-letters as a replay;
//   - a send that SUCCEEDED marks the entry `sent`; the inbound is then acked,
//     and an ack that fails is retried on the next check without re-sending;
//   - the journal is re-read on every check, so a restart finishes whatever a
//     crash interrupted — re-send (same messageId) or re-ack.
// What the journal cannot cover, stated: a crash while the launcher runs
// (before the entry exists) leaves the inbound unacked in cur/; the CLI
// re-presents it when its lease expires and the launcher runs again
// (at-least-once). A journal entry that cannot be written blocks the send (the
// same re-presentation applies), so every reply that leaves has an entry.
import { signedTrustTier } from "@tpsdev-ai/agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { MailMessage, MailWatcher, WatchOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const POLL_INTERVAL_MS = 5000;
const RESCAN_INTERVAL_MS = 60_000; // run the verified check even when new/ is empty
const RETRY_BACKOFF_MS = 60_000; // first re-send after an unknown send outcome
const RETRY_BACKOFF_MAX_MS = 1_800_000; // backoff cap (30 minutes)
const CLI_TIMEOUT_MS = 30_000; // `tps mail check`
const SEND_TIMEOUT_MS = 30_000; // `tps mail send` (signing + delivery)
const ACK_TIMEOUT_MS = 10_000; // `tps mail ack`

const VALID_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * The signed-envelope id rule the CLI enforces on every envelope it promotes and
 * on `--reply-to` / `--message-id` (packages/cli/src/utils/envelope-id.ts),
 * mirrored so the watcher never hands the CLI a value it would refuse. The
 * local record id (the ack key and the journal file name) is held to it too.
 */
const ENVELOPE_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** One reply the watcher owes, from its first send until the inbound is acked. */
interface ReplyJournalEntry {
  v: 1;
  /** The inbound's local record id — the `tps mail ack` key. */
  inboundId: string;
  /** The VERIFIED sender: the reply's recipient. */
  to: string;
  /** The inbound's VERIFIED envelope messageId: the thread the reply signs. */
  threadId: string;
  /** The reply text (sent on stdin). */
  reply: string;
  /** The envelope messageId every attempt signs with (`--message-id`). */
  replyMessageId: string;
  /** `prepared`: not known to be delivered. `sent`: delivered; the ack is owed. */
  state: "prepared" | "sent";
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

interface Paths {
  mailRoot: string;
  inboxNew: string;
  journalDir: string;
  launcher: string;
  tpsVaultKey: string;
  tpsBin: string;
  agentId: string;
}

/** In-memory schedule for re-sends (the journal holds everything else). */
type Backoff = Map<string, { nextAttemptAt: number; backoffMs: number }>;

interface WatcherState {
  inboxRoot: string;
  options: WatchOptions;
  paths: Paths;
  backoff: Backoff;
  lastCheckAt: number;
  /** Set by stop(): no further CLI run or launcher run is started. */
  stopped: boolean;
}

function ts(): string {
  return new Date().toISOString();
}

function getAgentPaths(inboxRoot: string, options: WatchOptions): Paths {
  const agent = options.agent ?? "ember";

  // Validate agent ID to prevent path traversal
  if (!VALID_AGENT_ID.test(agent)) {
    throw new Error(`Invalid agent ID: ${agent}`);
  }

  const launcher = options.launcher ?? join(inboxRoot, "agents", agent, "bin", agent);
  const mailRoot = join(inboxRoot, ".tps", "mail");

  // Require TPS_VAULT_KEY env var — no fallback credential
  const tpsVaultKey = process.env.TPS_VAULT_KEY;
  if (!tpsVaultKey) {
    throw new Error("TPS_VAULT_KEY is required");
  }

  // Use installed CLI on PATH, or env var override
  const tpsBin = process.env.TPS_BIN || "tps";

  return {
    mailRoot,
    inboxNew: join(mailRoot, agent, "new"),
    journalDir: join(mailRoot, agent, ".pi-tps-mail", "replies"),
    launcher,
    tpsVaultKey,
    tpsBin,
    agentId: agent,
  };
}

/**
 * Run the CLI as the agent, against the mail root this watcher watches. Resolves
 * to the exit code (non-zero on a timeout) with stdout and a bounded stderr.
 */
async function runTps(
  paths: Paths,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; label: string },
): Promise<{ code: number; timedOut: boolean; stdout: string; stderr: string }> {
  const child = spawn(paths.tpsBin, args, {
    env: {
      ...process.env,
      TPS_VAULT_KEY: paths.tpsVaultKey,
      TPS_AGENT_ID: paths.agentId,
      TPS_MAIL_DIR: paths.mailRoot,
    },
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (d) => { stdout += d; });
  child.stderr!.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
  if (opts.stdin !== undefined) {
    // A child that exits before reading stdin makes the write fail (EPIPE):
    // that is a failed run, reported by the exit code — never an uncaught error.
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.stdin, "utf8");
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[${ts()}] tps ${opts.label} TIMEOUT — killing pid ${child.pid}`);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, opts.timeoutMs);
  timer.unref();

  const code = await new Promise<number>((r) => {
    child.on("error", () => r(127));
    child.on("close", (c) => r(c ?? 1));
  });
  clearTimeout(timer);
  return { code: timedOut && code === 0 ? 1 : code, timedOut, stdout, stderr: stderr.trim() };
}

// ─── the reply journal ──────────────────────────────────────────────────────

function journalPath(paths: Paths, inboundId: string): string {
  return join(paths.journalDir, `${inboundId}.json`);
}

async function writeJournal(paths: Paths, entry: ReplyJournalEntry): Promise<void> {
  await mkdir(paths.journalDir, { recursive: true, mode: 0o700 });
  const target = journalPath(paths, entry.inboundId);
  const tmp = join(paths.journalDir, `.${entry.inboundId}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...entry, updatedAt: ts() }, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

function isJournalEntry(x: unknown): x is ReplyJournalEntry {
  if (x === null || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.inboundId === "string" && ENVELOPE_ID_SHAPE.test(e.inboundId) &&
    typeof e.to === "string" && VALID_AGENT_ID.test(e.to) &&
    typeof e.threadId === "string" && ENVELOPE_ID_SHAPE.test(e.threadId) &&
    typeof e.replyMessageId === "string" && ENVELOPE_ID_SHAPE.test(e.replyMessageId) &&
    typeof e.reply === "string" &&
    (e.state === "prepared" || e.state === "sent") &&
    typeof e.attempts === "number"
  );
}

async function readJournal(paths: Paths): Promise<ReplyJournalEntry[]> {
  let names: string[];
  try {
    names = await readdir(paths.journalDir);
  } catch {
    return [];
  }
  const out: ReplyJournalEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      const entry: unknown = JSON.parse(await readFile(join(paths.journalDir, name), "utf8"));
      if (isJournalEntry(entry) && name === `${entry.inboundId}.json`) out.push(entry);
      else console.error(`[${ts()}] reply journal entry ${name} is malformed; left in place, not acted on`);
    } catch (err: unknown) {
      console.error(`[${ts()}] reply journal entry ${name} is unreadable (${(err as Error).message}); left in place`);
    }
  }
  return out;
}

async function hasJournal(paths: Paths, inboundId: string): Promise<boolean> {
  try {
    await readFile(journalPath(paths, inboundId), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ─── send / ack ─────────────────────────────────────────────────────────────

/**
 * One send attempt for a journal entry: the reply ON STDIN (never argv),
 * threaded to the verified inbound (`--reply-to`), signed with the entry's own
 * envelope messageId (`--message-id`) so every attempt is the same message. The
 * CLI signs with the agent's key and refuses (non-zero, nothing written) when it
 * cannot.
 */
async function attemptSend(state: WatcherState, entry: ReplyJournalEntry): Promise<void> {
  const { paths, backoff, options } = state;
  const due = backoff.get(entry.inboundId);
  if (due && Date.now() < due.nextAttemptAt) return; // backing off

  const attempt = entry.attempts + 1;
  const sent = await runTps(
    paths,
    ["mail", "send", entry.to, "--stdin", "--reply-to", entry.threadId, "--message-id", entry.replyMessageId],
    { stdin: entry.reply, timeoutMs: options.sendTimeoutMs ?? SEND_TIMEOUT_MS, label: "mail send" },
  );
  if (sent.code !== 0) {
    // The OUTCOME IS UNKNOWN: the CLI may have delivered before it failed or
    // was killed. Keep the entry `prepared` and re-send the same message later.
    const backoffMs = due
      ? Math.min(due.backoffMs * 2, RETRY_BACKOFF_MAX_MS)
      : (options.retryBackoffMs ?? RETRY_BACKOFF_MS);
    backoff.set(entry.inboundId, { nextAttemptAt: Date.now() + backoffMs, backoffMs });
    try {
      await writeJournal(paths, { ...entry, attempts: attempt });
    } catch { /* the attempt count is diagnostic only */ }
    console.error(
      `[${ts()}] tps mail send exited ${sent.code}${sent.timedOut ? " (timed out)" : ""} for the reply to ${entry.inboundId}` +
        `${sent.stderr ? `: ${sent.stderr}` : ""} — outcome unknown, NOT acknowledged; the same message ` +
        `(messageId ${entry.replyMessageId}) is re-sent in ${backoffMs}ms`,
    );
    return;
  }
  backoff.delete(entry.inboundId);
  const done: ReplyJournalEntry = { ...entry, attempts: attempt, state: "sent" };
  try {
    await writeJournal(paths, done);
  } catch (err: unknown) {
    // The reply went out but the journal still says `prepared`: a later check
    // re-sends the SAME message, which the recipient discards as a replay.
    console.error(
      `[${ts()}] reply journal write failed after a successful send for ${entry.inboundId} (${(err as Error).message}); ` +
        `a later check may re-send the same message (messageId ${entry.replyMessageId})`,
    );
  }
  console.log(`[${ts()}] replied to ${entry.to} (${entry.reply.length} chars, reply-to ${entry.threadId}, messageId ${entry.replyMessageId})`);
  await attemptAck(state, done);
}

/** Ack the inbound; on success the journal entry is done and removed. */
async function attemptAck(state: WatcherState, entry: ReplyJournalEntry): Promise<void> {
  const { paths, options } = state;
  const ack = await runTps(paths, ["mail", "ack", entry.inboundId], {
    timeoutMs: options.ackTimeoutMs ?? ACK_TIMEOUT_MS,
    label: "mail ack",
  });
  if (ack.code !== 0) {
    console.error(
      `[${ts()}] tps mail ack exited ${ack.code}${ack.timedOut ? " (timed out)" : ""} for ${entry.inboundId}` +
        `${ack.stderr ? `: ${ack.stderr}` : ""} — the reply was sent; the ack is retried on the next check (no re-send)`,
    );
    return;
  }
  console.log(`[${ts()}] acked ${entry.inboundId}`);
  try {
    await rm(journalPath(paths, entry.inboundId), { force: true });
  } catch (err: unknown) {
    console.error(`[${ts()}] could not remove the reply journal entry for ${entry.inboundId}: ${(err as Error).message}`);
  }
}

async function recoverJournal(state: WatcherState, verified: MailMessage[]): Promise<void> {
  for (const entry of await readJournal(state.paths)) {
    if (state.stopped) return;
    let inbound = verified.find((msg) => msg.id === entry.inboundId);
    if (!inbound) {
      const read = await runTps(state.paths, ["mail", "read", state.paths.agentId, entry.inboundId, "--json"], {
        timeoutMs: state.options.checkTimeoutMs ?? CLI_TIMEOUT_MS, label: "mail read",
      });
      if (read.code === 0) {
        try { inbound = JSON.parse(read.stdout); } catch { /* withhold */ }
      }
    }
    if (!inbound?.envelope || inbound.id !== entry.inboundId || externalTier(inbound) || inbound.from !== entry.to || inbound.envelopeId !== entry.threadId) continue;
    if (entry.state === "sent") await attemptAck(state, entry);
    else await attemptSend(state, entry);
  }
}

// ─── verified inbound ───────────────────────────────────────────────────────

async function checkVerified(state: WatcherState): Promise<MailMessage[]> {
  const res = await runTps(state.paths, ["mail", "check", state.paths.agentId, "--json"], {
    timeoutMs: state.options.checkTimeoutMs ?? CLI_TIMEOUT_MS,
    label: "mail check",
  });
  if (res.code !== 0) {
    console.error(`[${ts()}] tps mail check exited ${res.code}${res.stderr ? `: ${res.stderr}` : ""}; nothing dispatched`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    console.error(`[${ts()}] tps mail check printed no JSON array; nothing dispatched`);
    return [];
  }
  return Array.isArray(parsed) ? (parsed as MailMessage[]) : [];
}

function externalTier(msg: MailMessage): boolean {
  return (msg.trustTier ?? (msg.envelope?.trust === undefined ? undefined : signedTrustTier(msg.envelope.trust))) === "external";
}

async function newHasMail(paths: Paths): Promise<boolean> {
  try {
    return (await readdir(paths.inboxNew)).some((f) => !f.startsWith("."));
  } catch {
    return false;
  }
}

/** Dispatch ONE verified inbound: launcher → journal → send → ack. */
async function dispatchVerified(state: WatcherState, msg: MailMessage): Promise<void> {
  const { paths, inboxRoot, options } = state;
  const id = msg?.id;
  const threadId = msg?.envelopeId;
  if (
    typeof id !== "string" || !ENVELOPE_ID_SHAPE.test(id) ||
    typeof msg.from !== "string" || !VALID_AGENT_ID.test(msg.from) ||
    typeof threadId !== "string" || !ENVELOPE_ID_SHAPE.test(threadId) ||
    typeof msg.body !== "string"
  ) {
    console.error(`[${ts()}] a verified record lacks a usable id, sender or envelope id; not dispatched`);
    return;
  }
  if (externalTier(msg)) {
    console.error(`[${ts()}] not dispatching ${id}: external-tier mail`);
    return;
  }
  // A reply already produced for this inbound is finished from the journal
  // (re-send or re-ack) — never produced a second time.
  if (await hasJournal(paths, id)) return;
  if (state.stopped) return;

  console.log(`[${ts()}] dispatching ${id} from ${msg.from} (verified, envelope ${threadId})`);
  const reply = await runLauncher(paths, inboxRoot, options, msg.body, id);
  const entry: ReplyJournalEntry = {
    v: 1,
    inboundId: id,
    to: msg.from,
    threadId,
    reply,
    replyMessageId: randomUUID(),
    state: "prepared",
    attempts: 0,
    createdAt: ts(),
    updatedAt: ts(),
  };
  try {
    await writeJournal(paths, entry);
  } catch (err: unknown) {
    console.error(
      `[${ts()}] reply journal write failed for ${id} (${(err as Error).message}); NOT sending — ` +
        `the inbound stays unacked and is re-presented when its lease expires`,
    );
    return;
  }
  if (state.stopped) return;
  await attemptSend(state, entry);
}

/** Run the agent launcher on the inbound body; resolves to the reply text. */
async function runLauncher(
  paths: Paths,
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
    console.error(`[${ts()}] launcher dispatch TIMEOUT after ${timeoutMs}ms for ${msgId} — killing pid ${child.pid}`);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
  }, timeoutMs);
  timer.unref();

  const code = await new Promise<number>((r) => child.on("close", r));
  clearTimeout(timer);

  if (code !== 0) {
    console.error(`[${ts()}] launcher exited ${code} for ${msgId}${timedOut ? " (timed out)" : ""}`);
  }

  return timedOut
    ? `(launcher dispatch timed out after ${timeoutMs}ms — partial stdout ${stdout.length}B, stderr: ${stderr.slice(0, 500)})`
    : (stdout.trim() || `(no output, stderr: ${stderr.slice(0, 500)})`);
}

/**
 * One poll: when new/ holds anything, or the rescan
 * interval has passed (lease-expired cur/ records, a retryable dlq/ entry) —
 * run the verified check and dispatch what it returns.
 */
async function pollOnce(state: WatcherState): Promise<void> {
  const rescanDue = Date.now() - state.lastCheckAt >= (state.options.rescanIntervalMs ?? RESCAN_INTERVAL_MS);
  if (state.stopped) return;
  let verified: MailMessage[] = [];
  if (rescanDue || await newHasMail(state.paths)) {
    state.lastCheckAt = Date.now();
    verified = await checkVerified(state);
  }
  await recoverJournal(state, verified);
  for (const msg of verified) {
    if (state.stopped) return;
    try {
      await dispatchVerified(state, msg);
    } catch (err: unknown) {
      console.error(`[${ts()}] dispatch error: ${(err as Error).message}`);
    }
  }
}

export function watchMail(options: WatchOptions = {}): MailWatcher {
  const inboxRoot = options.inboxRoot ?? homedir();
  const paths = getAgentPaths(inboxRoot, options);
  console.log(`pi-tps-mail watcher starting for agent=${paths.agentId}, inbox=${paths.inboxNew}`);

  const state: WatcherState = { inboxRoot, options, paths, backoff: new Map(), lastCheckAt: 0, stopped: false };

  // The poll in flight, so drain() can wait for it after stop().
  let inflight: Promise<void> = Promise.resolve();
  const processMsg = () => {
    if (state.stopped) return;
    inflight = pollOnce(state)
      .catch((err: unknown) => {
        console.error(`[${ts()}] poll error: ${(err as Error).message}`);
      })
      .then(() => {
        if (!state.stopped) setTimeout(processMsg, options.pollIntervalMs ?? POLL_INTERVAL_MS);
      });
  };

  // Start polling
  processMsg();

  return {
    stop() {
      state.stopped = true;
      console.log("pi-tps-mail watcher stopped.");
    },
    drain() {
      return inflight;
    },
  };
}
