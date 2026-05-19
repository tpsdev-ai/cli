import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { logEvent } from "./archive.js";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read: boolean;
  ackedAt?: string;
  nackedAt?: string;
  nackReason?: string;
  nackType?: "transient" | "agent" | "permanent";
  checkedOutAt?: string;
  checkedOutBy?: string;
  deliveryAttempts?: number;
  retryAfter?: string;
  prNumber?: number;
  headers?: Record<string, string>;
}

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_INBOX_MESSAGES = 100;
const LEASE_TIMEOUT_MS = 30 * 60 * 1000;

const VALID_ID = /^[a-zA-Z0-9._-]+$/;
export function validateMessageId(id: string): void {
  if (!VALID_ID.test(id)) throw new Error(`Invalid message ID: ${id}`);
}

function assertValidAgentId(agent: string): void {
  const safe = sanitizeIdentifier(agent);
  if (!agent || safe !== agent) {
    throw new Error(`Invalid agent id: ${agent}`);
  }
}

export function assertValidBody(body: string): void {
  if (body.includes("\u0000")) {
    throw new Error("Message body contains invalid null byte.");
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(`Message body exceeds maximum size (64KB). Got ${Math.ceil(bytes / 1024)}KB.`);
  }
}

export function getMailDir(): string {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns true if an inbox directory already exists for `agent` — without
 * creating one. Use this when you need to choose a routing target between
 * candidate recipients (e.g. branch service deciding whether to deliver to
 * body.to or fall back to its own identity).
 */
export function inboxExists(agent: string): boolean {
  try {
    assertValidAgentId(agent);
  } catch {
    return false;
  }
  const branchMailRoot = join(process.env.HOME || homedir(), ".tps", "branch-office", agent, "mail");
  if (existsSync(branchMailRoot)) return true;
  return existsSync(join(getMailDir(), agent));
}

export function getInbox(agent: string): { root: string; tmp: string; fresh: string; cur: string; dlq: string } {
  assertValidAgentId(agent);

  // Branch-office compatibility: if this agent has a local branch-office mail root,
  // prefer that over ~/.tps/mail/<agent>. This keeps `tps mail check <agent>` aligned
  // with branch delivery paths used by relay/deliverToSandbox.
  const branchMailRoot = join(process.env.HOME || homedir(), ".tps", "branch-office", agent, "mail");
  const root = existsSync(branchMailRoot) ? branchMailRoot : join(getMailDir(), agent);
  const tmp = join(root, "tmp");
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  const dlq = join(root, "dlq");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  mkdirSync(cur, { recursive: true });
  mkdirSync(dlq, { recursive: true });
  return { root, tmp, fresh, cur, dlq };
}

function readMessagesFromDir(dir: string, read: boolean): MailMessage[] {
  if (!existsSync(dir)) return [];
  const messages: MailMessage[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      const msg = JSON.parse(raw) as MailMessage;
      msg.read = read;
      messages.push(msg);
    } catch (err: any) {
      console.error(`[mail] skipping corrupt message ${f}: ${err.message}`);
    }
  }
  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

function listMessageFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

function readMessageFile(path: string): MailMessage {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MailMessage;
  } catch (err: any) {
    throw new Error(`corrupt message file ${path}: ${err.message}`);
  }
}

function writeMessageFile(path: string, msg: MailMessage): void {
  writeFileSync(path, JSON.stringify(msg, null, 2), "utf-8");
}

function isLeaseExpired(msg: MailMessage, now = Date.now()): boolean {
  if (!msg.checkedOutAt) return true;
  return (now - Date.parse(msg.checkedOutAt)) > LEASE_TIMEOUT_MS;
}

function parseDurationMs(raw?: string, fallbackMs = 24 * 60 * 60 * 1000): number {
  if (!raw) return fallbackMs;
  const m = raw.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

function messagePathById(agent: string, id: string): string | null {
  validateMessageId(id);
  const inbox = getInbox(agent);
  for (const dir of [inbox.fresh, inbox.cur, inbox.dlq]) {
    for (const file of listMessageFiles(dir)) {
      const full = join(dir, file);
      const msg = readMessageFile(full);
      if (msg.id === id || msg.id.startsWith(id)) return full;
    }
  }
  return null;
}

/**
 * Count of UNPROCESSED inbox messages — files in new/.
 *
 * The MAX_INBOX_MESSAGES cap is back-pressure for "agent isn't processing,"
 * not "agent ran for too long." Previously this counted new+cur, which meant
 * a busy agent's processed-but-not-archived mail would silently bounce
 * incoming dispatches. Anvil hit this 2026-05-19 with 100 cur/ entries dating
 * back to May 4 — fresh dispatches NACK'd with "Inbox full" while his
 * processed mail sat there. Pair with archiveOldCur() for cur hygiene.
 */
export function countInboxMessages(agent: string): number {
  const inbox = getInbox(agent);
  return readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")).length;
}

/**
 * Archive cur/ messages older than maxAgeDays to archive/YYYY-MM/.
 *
 * Returns the count moved. Idempotent and non-failing — corrupt or unreadable
 * files are skipped without blocking the others. Called opportunistically
 * from mail check / mail watch so the cap doesn't drift back into the
 * combined-count failure mode if a future change re-introduces it.
 *
 * The 30-day default is conservative: agents that ack mail are essentially
 * done with it, and the audit log + git history are the durable record. cur/
 * just holds the "processed but not yet GC'd" tail.
 */
export function archiveOldCur(agent: string, maxAgeDays = 30): number {
  const inbox = getInbox(agent);
  if (!existsSync(inbox.cur)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const archiveRoot = join(inbox.root, "archive");
  let moved = 0;
  for (const file of readdirSync(inbox.cur).filter((f) => f.endsWith(".json"))) {
    const src = join(inbox.cur, file);
    try {
      const st = statSync(src);
      // Use mtime as the archive boundary — covers both naturally-old files
      // and ones manually touched. Most cur/ entries are written-once when
      // ack'd, so mtime ≈ when the agent processed them.
      if (st.mtimeMs > cutoffMs) continue;
      const ts = new Date(st.mtimeMs);
      const monthDir = join(archiveRoot, `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}`);
      mkdirSync(monthDir, { recursive: true });
      renameSync(src, join(monthDir, file));
      moved++;
    } catch {
      // Skip on stat/rename failure — non-fatal; next call retries.
    }
  }
  return moved;
}

export function sendMessage(to: string, body: string, from?: string): MailMessage & { filePath: string } {
  assertValidAgentId(to);
  const sender = from || "unknown";
  assertValidAgentId(sender);
  assertValidBody(body);

  // Guard: when running in test mode or when the caller has explicitly
  // opted in, refuse to write to the default ~/.tps/mail/ directory
  // unless TPS_MAIL_DIR is set. This prevents tests from accidentally
  // spraying messages into the real production maildir (e.g. when
  // imported directly without beforeEach setting TPS_MAIL_DIR to a temp dir).
  if ((process.env.NODE_ENV === "test" || process.env.TPS_MAIL_REQUIRE_EXPLICIT_DIR) && !process.env.TPS_MAIL_DIR) {
    throw new Error(
      "TPS_MAIL_DIR must be set explicitly in test mode. " +
      "Refusing to write to the default production maildir.",
    );
  }

  const inbox = getInbox(to);
  const quotaCount = countInboxMessages(to);
  if (quotaCount >= MAX_INBOX_MESSAGES) {
    throw new Error("Inbox full");
  }

  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const message: MailMessage = {
    id,
    from: sender,
    to,
    body,
    timestamp,
    read: false,
    headers: { "X-TPS-Trust": "user", "X-TPS-Sender": sender },
  };

  const safeTs = timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  const tmpPath = join(inbox.tmp, filename);
  const newPath = join(inbox.fresh, filename);
  writeFileSync(tmpPath, JSON.stringify(message, null, 2), "utf-8");
  renameSync(tmpPath, newPath);

  logEvent({ event: "sent", from: sender, to, messageId: id }, body);

  return { ...message, filePath: newPath };
}

export function checkMessages(agent: string, checkedOutBy = agent): MailMessage[] {
  assertValidAgentId(agent);
  assertValidAgentId(checkedOutBy);
  const inbox = getInbox(agent);

  // Opportunistic cur/ archive — keeps the processed tail from accumulating
  // indefinitely. Safe to no-op when there's nothing old; cost is one stat()
  // per cur entry, capped at the directory size.
  try { archiveOldCur(agent); } catch { /* non-fatal */ }

  const messages: MailMessage[] = [];
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  for (const f of listMessageFiles(inbox.fresh)) {
    const from = join(inbox.fresh, f);
    const to = join(inbox.cur, f);
    renameSync(from, to);
    const msg = readMessageFile(to);
    msg.read = false;
    msg.checkedOutAt = nowIso;
    msg.checkedOutBy = checkedOutBy;
    msg.deliveryAttempts = (msg.deliveryAttempts ?? 0) + 1;
    writeMessageFile(to, msg);
    messages.push(msg);
    logEvent({ event: "read", from: msg.from, to: agent, messageId: msg.id }, msg.body);
  }

  for (const f of listMessageFiles(inbox.cur)) {
    const full = join(inbox.cur, f);
    const msg = readMessageFile(full);
    if (msg.read || msg.nackedAt) continue;
    if (msg.retryAfter && Date.parse(msg.retryAfter) > nowMs) continue;
    if (msg.checkedOutBy && !isLeaseExpired(msg, nowMs)) continue;
    msg.checkedOutAt = nowIso;
    msg.checkedOutBy = checkedOutBy;
    writeMessageFile(full, msg);
    messages.push(msg);
  }

  // Best-effort GC: purge acked/expired messages older than 24h on every check
  try { gcMessages(agent); } catch { /* never block delivery */ }

  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function listMessages(agent: string): MailMessage[] {
  assertValidAgentId(agent);
  const inbox = getInbox(agent);
  const unread = readMessagesFromDir(inbox.fresh, false);
  const cur = readMessagesFromDir(inbox.cur, true);
  const dlq = readMessagesFromDir(inbox.dlq, true);
  return [...unread, ...cur, ...dlq].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function ackMessage(agent: string, id: string): MailMessage | null {
  const path = messagePathById(agent, id);
  if (!path) return null;
  const msg = readMessageFile(path);
  msg.read = true;
  msg.ackedAt = new Date().toISOString();
  delete msg.nackedAt;
  delete msg.nackReason;
  delete msg.nackType;
  delete msg.checkedOutAt;
  delete msg.checkedOutBy;
  delete msg.retryAfter;
  writeMessageFile(path, msg);
  // Remove the file from cur/ now that it's acked — audit trail is in log/
  try { unlinkSync(path); } catch { /* best effort — don't fail ack if cleanup fails */ }
  return msg;
}

export function nackMessage(agent: string, id: string, reason: string, type: "transient" | "agent" | "permanent" = "transient", retryAfter?: string): MailMessage | null {
  const path = messagePathById(agent, id);
  if (!path) return null;
  const msg = readMessageFile(path);
  msg.read = false;
  msg.nackedAt = new Date().toISOString();
  msg.nackReason = reason;
  msg.nackType = type;
  msg.checkedOutAt = undefined;
  msg.checkedOutBy = undefined;
  if (type === "transient" && retryAfter) {
    msg.retryAfter = new Date(Date.now() + parseDurationMs(retryAfter, 60_000)).toISOString();
  } else {
    delete msg.retryAfter;
  }
  if (type === "permanent") {
    const inbox = getInbox(agent);
    const target = join(inbox.dlq, path.split("/").pop()!);
    writeMessageFile(path, msg);
    renameSync(path, target);
    return msg;
  }
  writeMessageFile(path, msg);
  return msg;
}

export function gcMessages(agent?: string, maxAge = "24h", prNumber?: number, hardTtl = "48h"): number {
  const agents = agent ? [agent] : (existsSync(getMailDir()) ? readdirSync(getMailDir()).filter((d) => existsSync(join(getMailDir(), d, "cur"))) : []);
  let removed = 0;
  const doneCutoff = Date.now() - parseDurationMs(maxAge, 24 * 60 * 60 * 1000);
  const hardCutoff = Date.now() - parseDurationMs(hardTtl, 48 * 60 * 60 * 1000);
  for (const a of agents) {
    const inbox = getInbox(a);
    for (const dir of [inbox.fresh, inbox.cur, inbox.dlq]) {
      for (const file of listMessageFiles(dir)) {
        const full = join(dir, file);
        const msg = readMessageFile(full);
        const ts = Date.parse(msg.ackedAt ?? msg.timestamp);
        const hardTs = Date.parse(msg.timestamp);
        const done = msg.read && !!msg.ackedAt;
        const prMatch = prNumber == null || msg.prNumber === prNumber || msg.body.includes(`#${prNumber}`) || msg.body.includes(`PR #${prNumber}`);
        if (!prMatch) continue;
        if ((done && ts < doneCutoff) || hardTs < hardCutoff) {
          rmSync(full, { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
