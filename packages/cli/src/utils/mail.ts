import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { MailDeliverBodySchema } from "./wire-mail.js";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  decideEnvelopeForMailbox as decideEnvelope,
  type Envelope, PublicKeyFormatError, verifiedMailTier, bridgePrincipalIds,
  mailboxReplayStore, hasCommittedMessageId,
  parseSignedEnvelope,
  peekConsumedForMailboxRoot,
  placeCurRecord,
} from "@tpsdev-ai/agent";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { logEvent } from "./archive.js";
import { acquireMailLock, acquireMailLockSync, mailLockPath, type MailLock } from "./mail-lock.js";
import { createMailVerifyClient, type MailVerifyConfig } from "./mail-verify.js";

// cli#429: the ONE id shape rule, re-exported so the openclaw-tps-mail plugin
// (which imports this module) applies the same rule the CLI does.
export { ENVELOPE_ID_SHAPE, ENVELOPE_ID_SHAPE_TEXT, isValidEnvelopeId } from "./envelope-id.js";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  receivedAt?: string;
  read: boolean;
  ackedAt?: string;
  bridgeSentAt?: string;
  nackedAt?: string;
  nackReason?: string;
  nackType?: "transient" | "agent" | "permanent";
  checkedOutAt?: string;
  checkedOutBy?: string;
  deliveryAttempts?: number;
  retryAfter?: string;
  prNumber?: number;
  headers?: Record<string, string>;
  /** Set by listMessages(): which maildir the record came from. */
  location?: "new" | "cur" | "dlq";
  /** The verified envelope's messageId, persisted so replay is detectable. */
  envelopeId?: string;
  relayDelivery?: { branchId: string; id: string };
  relayPayload?: { from: string; to: string; body: string; timestamp: string };
  relayWireTo?: string;
  /**
   * The full SIGNED envelope, persisted at promotion so a later cur/ re-read
   * (crash recovery / lease sweep) can re-verify it. Binds "verified at
   * promote" to "presented at dispatch": a local tamper of the record between
   * the two either breaks this envelope's signature or fails the field match.
   */
  envelope?: Envelope;
  trustTier?: "user" | "internal" | "external";
  /**
   * cli#429: the signed `messageId` this message replies to, stamped from the
   * VERIFIED envelope at promotion (it is also bound to the envelope by
   * ENVELOPE_BINDINGS.replyToId, so it cannot diverge from what was signed).
   * Absent for a message that is not a reply, and REMOVED from every
   * unverified presentation (see withholdUnverified).
   */
  replyToId?: string;
  /** Set by listMessages() for dlq records: the sidecar reason class. */
  rejectClass?: string;
  rejectReason?: string;
}

export const MAX_BODY_BYTES = 64 * 1024;
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

/** The mail directory path, without creating it. */
function mailDirPath(): string {
  return process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
}

export function getMailDir(): string {
  const dir = mailDirPath();
  mkdirMailDirectory(dir);
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

/** The mailbox root `getInbox` uses, resolved without creating anything. */
function mailboxRoot(agent: string): string {
  assertValidAgentId(agent);

  // Branch-office compatibility: if this agent has a local branch-office mail root,
  // prefer that over ~/.tps/mail/<agent>. This keeps `tps mail check <agent>` aligned
  // with branch delivery paths used by relay/deliverToSandbox.
  const branchMailRoot = join(process.env.HOME || homedir(), ".tps", "branch-office", agent, "mail");
  return existsSync(branchMailRoot) ? branchMailRoot : join(mailDirPath(), agent);
}

/**
 * The mailbox root relay acceptance locks and publishes into: `agent`'s own
 * mailbox, or the host-level `.undeliverable` tree when `agent` is not a valid
 * id (a relayed delivery to an invalid recipient is dead-lettered there).
 */
export function relayAcceptRoot(agent: string): string {
  try {
    return mailboxRoot(agent);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("Invalid agent id"))) throw error;
    return join(mailDirPath(), ".undeliverable");
  }
}

export function getInbox(agent: string): { root: string; tmp: string; fresh: string; cur: string; dlq: string } {
  const root = mailboxRoot(agent);
  const tmp = join(root, "tmp");
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  const dlq = join(root, "dlq");
  mkdirMailDirectory(tmp);
  mkdirMailDirectory(fresh);
  mkdirMailDirectory(cur);
  mkdirMailDirectory(dlq);
  return { root, tmp, fresh, cur, dlq };
}

function readMessagesFromDir(dir: string, read: boolean, location: "new" | "cur" | "dlq"): MailMessage[] {
  if (!existsSync(dir)) return [];
  const messages: MailMessage[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      const msg = JSON.parse(raw) as MailMessage;
      msg.read = read;
      msg.location = location;
      if (location === "dlq") {
        const side = readReasonSidecar(dir, f);
        if (side) {
          msg.rejectClass = side.cls;
          msg.rejectReason = side.reason;
        }
      }
      messages.push(msg);
    } catch (err: any) {
      console.error(`[mail] skipping corrupt message ${f}: ${err.message}`);
    }
  }
  return messages.sort((a, b) => ((a.receivedAt ?? a.timestamp) < (b.receivedAt ?? b.timestamp) ? 1 : -1));
}

function listMessageFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // Files only — a directory named `*.json` (e.g. a fault injection or a
  // stray artifact) must never be handed to a reader and throw EISDIR.
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
}

function readMessageFile(path: string): MailMessage {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MailMessage;
  } catch (err: any) {
    throw Object.assign(new Error(`corrupt message file ${path}: ${err.message}`), { code: err?.code });
  }
}

export type UpdateExistingResult<T> = { status: "updated"; record: T } | { status: "gone" | "changed" | "busy" };

export function updateExistingRecord<T extends object>(
  path: string,
  mutate: (record: T) => T | null,
  options: { snapshot?: T; afterWrite?: (record: T) => void; nonBlocking?: boolean } = {},
): UpdateExistingResult<T> {
  const root = dirname(dirname(path));
  let lock: MailLock | null;
  try {
    lock = acquireMailLockSync(root, options.nonBlocking ? { timeoutMs: 0 } : {});
  } catch (err: any) {
    throw Object.assign(err, { path: err?.path ?? mailLockPath(root) });
  }
  if (!lock) {
    if (options.nonBlocking) return { status: "busy" };
    throw Object.assign(new Error(`mail lock contention timeout for ${path}`), { path: mailLockPath(root) });
  }
  const scratchPath = join(dirname(path), `.ack-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let replaced = false;
  try {
    statSync(path);
    const fresh = JSON.parse(readFileSync(path, "utf-8")) as T;
    if (options.snapshot && JSON.stringify(fresh) !== JSON.stringify(options.snapshot)) return { status: "changed" };
    const updated = mutate(fresh);
    if (updated === null) return { status: "changed" };
    statSync(path);
    fd = openSync(scratchPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(updated, null, 2), "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    statSync(path);
    renameSync(scratchPath, path);
    replaced = true;
    options.afterWrite?.(updated);
    return { status: "updated", record: updated };
  } catch (err: any) {
    if (!replaced && err?.code === "ENOENT" && err?.path === path) return { status: "gone" };
    throw err;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { rmSync(scratchPath, { force: true }); } catch {}
    lock.release();
  }
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

function messagePathById(agent: string, id: string, mailRoot?: string): string | null {
  validateMessageId(id);
  const resolvedInbox = mailRoot === undefined ? getInbox(agent) : {
    fresh: join(mailRoot, agent, "new"), cur: join(mailRoot, agent, "cur"), dlq: join(mailRoot, agent, "dlq"),
  };
  let prefixMatch: string | null = null;
  for (const dir of [resolvedInbox.fresh, resolvedInbox.cur, resolvedInbox.dlq]) {
    for (const file of listMessageFiles(dir)) {
      const full = join(dir, file);
      const msg = readMessageFile(full);
      if (msg.id === id) return full;
      if (prefixMatch === null && msg.id.startsWith(id)) prefixMatch = full;
    }
  }
  return prefixMatch;
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
 * The "Inbox full" rejection, phrased so the SENDER can act on it.
 *
 * The cap is back-pressure aimed at the recipient, but the recipient is the
 * one party the throw never reaches — a sender sees the error, the blocked
 * agent sees nothing. A bare "Inbox full" therefore stranded the useful
 * detail on the wrong side of the wire: which agent, how deep, and what
 * clears it. Flint's inbox sat at the cap silently bouncing agent mail
 * because every diagnostic said "full" and none said "run mail check".
 *
 * Naming the remedy matters more than naming the number: `mail check` is the
 * only path that drains new/ (and runs archiveOldCur); `mail log` and reading
 * the maildir directly do neither, which is exactly how an inbox reaches the
 * cap without anyone noticing.
 */
export function inboxFullMessage(recipient: string, count: number): string {
  return (
    `Inbox full: ${recipient} has ${count} unprocessed messages (cap ${MAX_INBOX_MESSAGES}). ` +
    `Message NOT delivered. ${recipient} must run \`tps mail check ${recipient}\` to drain new/ — ` +
    `note that \`mail log\` and reading the maildir directly do not consume.`
  );
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
  const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
  if (!lock) return 0;
  try {
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
  } finally { lock.release(); }
}

export class MailSyncError extends Error {
  constructor(cause: unknown) {
    super("mail fsync failed", { cause });
  }
}

export function syncMailFile(path: string): void {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (cause) { throw new MailSyncError(cause); }
}

export function syncMailDirectory(path: string): void {
  syncMailFile(path);
}

const pendingDirectorySyncs = new Set<string>();

export function mkdirMailDirectory(path: string): void {
  const target = resolve(path);
  const created = mkdirSync(target, { recursive: true });
  if (created) {
    const stop = dirname(resolve(created));
    for (let dir = dirname(target); ; dir = dirname(dir)) {
      pendingDirectorySyncs.add(dir);
      if (dir === stop) break;
    }
  }
  for (const dir of pendingDirectorySyncs) {
    if (target !== dir && !target.startsWith(dir.endsWith(sep) ? dir : dir + sep)) continue;
    syncMailDirectory(dir);
    pendingDirectorySyncs.delete(dir);
  }
}

function publishRelayedRecord(tmp: string, target: string): void {
  syncMailFile(tmp);
  renameSync(tmp, target);
  syncMailDirectory(dirname(target));
  if (dirname(tmp) !== dirname(target)) syncMailDirectory(dirname(tmp));
}

const RelayPayloadSchema = z.object({ from: MailDeliverBodySchema.shape.from, to: MailDeliverBodySchema.shape.to, body: z.string(), timestamp: MailDeliverBodySchema.shape.timestamp });
const MailRecordSchema = RelayPayloadSchema.extend({
  id: z.string().min(1).regex(VALID_ID),
  read: z.boolean(),
  receivedAt: z.string().optional(),
  ackedAt: z.string().optional(),
  bridgeSentAt: z.string().optional(),
  nackedAt: z.string().optional(),
  nackReason: z.string().optional(),
  nackType: z.enum(["transient", "agent", "permanent"]).optional(),
  checkedOutAt: z.string().optional(),
  checkedOutBy: z.string().optional(),
  deliveryAttempts: z.number().int().nonnegative().optional(),
  retryAfter: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
  location: z.enum(["new", "cur", "dlq"]).optional(),
  envelopeId: z.string().optional(),
  envelope: z.custom<Envelope>((value) => parseSignedEnvelope(JSON.stringify(value)).ok).optional(),
  trustTier: z.enum(["user", "internal", "external"]).optional(),
  replyToId: z.string().optional(),
  rejectClass: z.string().optional(),
  rejectReason: z.string().optional(),
  relayDelivery: z.object({ branchId: z.string().regex(/^[a-zA-Z0-9_-]+$/), id: MailDeliverBodySchema.shape.id }).optional(),
  relayPayload: RelayPayloadSchema.optional(),
  relayWireTo: MailDeliverBodySchema.shape.to.optional(),
}).passthrough();

/**
 * Records without a `relayDelivery` property stay in place (cli#560).
 * Malformed records with it are quarantined only in the recipient's mailbox,
 * even when its value is invalid (e.g. null).
 */
function carriesRelayDelivery(parsed: unknown, raw: string): boolean {
  if (parsed !== null && typeof parsed === "object") return (parsed as Record<string, unknown>).relayDelivery !== undefined;
  return /"relayDelivery"\s*:/.test(raw);
}

export function findRelayedRecord(agent: string, delivery: { branchId: string; id: string }, payload: z.infer<typeof RelayPayloadSchema>, wireRecipient = payload.to, options: { heldRoot?: string; acquireLock?: (root: string) => MailLock } = {}): string | undefined {
  const root = relayAcceptRoot(agent);
  const roots = new Set([root]);
  for (const parent of [mailDirPath(), join(process.env.HOME || homedir(), ".tps", "branch-office")]) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (parent === mailDirPath() && entry.name === ".undeliverable") roots.add(join(parent, entry.name));
      else if (/^[a-zA-Z0-9_-]+$/.test(entry.name)) {
        const candidate = parent === mailDirPath() ? join(parent, entry.name) : join(parent, entry.name, "mail");
        if (existsSync(candidate)) roots.add(candidate);
      }
    }
  }
  // The scan reads every mailbox — a same-id resend may name a different
  // recipient, and its conflict must still be found. But it may only MOVE a
  // record out of the recipient's own mailbox (cli#560): a record in any other
  // mailbox that is not this delivery's is left exactly where it is.
  const recipientRoot = root;
  for (const root of roots) {
    mkdirMailDirectory(root);
    // A caller that already holds this mailbox's lock (relay acceptance holds
    // the recipient's across check, publication and marker) passes it here so
    // the scan does not re-acquire it — a nested acquisition is a hard error.
    const held = root === options.heldRoot;
    const lock = held ? null : options.acquireLock ? options.acquireLock(root) : acquireMailLockSync(root);
    if (!held && !lock) throw new Error(`mailbox busy for relayed message ${delivery.id}`);
    try {
      for (const dir of ["new", "cur", "dlq"]) {
        const path = join(root, dir);
        for (const file of listMessageFiles(path)) {
          const source = join(path, file);
          let raw: string;
          try {
            raw = readFileSync(source, "utf-8");
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = `relayed record read failed: ${source}: ${reason}`;
            console.error(`[mail] ${message}`);
            throw new Error(message, { cause: error });
          }
          let record: MailMessage | undefined;
          let parsed: unknown;
          let parseError: unknown;
          try {
            parsed = JSON.parse(raw);
            MailRecordSchema.parse(parsed);
            record = parsed as MailMessage;
          } catch (error) {
            parseError = error;
          }
          if (!record) {
            // cli#560: records without a relayDelivery property stay in place.
            // Malformed records with it are quarantined only in the recipient's
            // own mailbox, even when its value is invalid (e.g. null).
            if (root !== recipientRoot || !carriesRelayDelivery(parsed, raw)) continue;
            const reason = parseError instanceof Error ? parseError.message : String(parseError);
            console.error(`[mail] unreadable record ${source}: ${reason}`);
            const quarantine = join(root, "quarantine");
            mkdirMailDirectory(quarantine);
            const target = join(quarantine, `${dir}-${randomUUID()}-${file}`);
            writeFileSync(`${target}.reason`, `class: invalid\nSource: ${source}\nReason: ${reason}\n`, { flag: "wx" });
            syncMailFile(`${target}.reason`);
            syncMailFile(source);
            renameSync(source, target);
            syncMailDirectory(quarantine);
            syncMailDirectory(path);
            continue;
          }
          if (record.relayDelivery?.branchId === delivery.branchId && record.relayDelivery.id === delivery.id) {
            const stored = record.envelope ? record.relayPayload ?? record : record;
            const originalEnvelope = record.envelope && record.relayPayload ? parseSignedEnvelope(record.relayPayload.body) : undefined;
            const projectionChanged = record.envelope && record.relayPayload && (
              record.from !== record.envelope.from || record.to !== record.envelope.to ||
              record.body !== record.envelope.body || record.timestamp !== record.envelope.timestamp ||
              !originalEnvelope?.ok || !isDeepStrictEqual(originalEnvelope.envelope, record.envelope)
            );
            if (projectionChanged || (record.relayWireTo ?? stored.to) !== wireRecipient || stored.from !== payload.from || stored.to !== payload.to || stored.body !== payload.body || stored.timestamp !== payload.timestamp) {
              throw new Error(`relayed delivery conflict for branch ${delivery.branchId} message ${delivery.id}`);
            }
            const target = join(path, file);
            record.receivedAt = new Date().toISOString();
            const tmpDir = join(root, "tmp");
            mkdirMailDirectory(tmpDir);
            const tmp = join(tmpDir, `${randomUUID()}.json`);
            writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", flag: "wx" });
            publishRelayedRecord(tmp, target);
            if (dir === "dlq") syncMailFile(`${target}.reason`);
            syncMailDirectory(path);
            return target;
          }
        }
      }
    } finally { lock?.release(); }
  }
  return undefined;
}

export function sendMessage(to: string, body: string, from?: string, relayDelivery?: { branchId: string; id: string }, senderTimestamp?: string, wireRecipient = to): MailMessage & { filePath: string } {
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
    throw new Error(inboxFullMessage(to, quotaCount));
  }

  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const message: MailMessage = {
    id,
    from: sender,
    to,
    body,
    timestamp: senderTimestamp ?? timestamp,
    read: false,
    headers: { "X-TPS-Trust": "user", "X-TPS-Sender": sender },
    ...(relayDelivery ? { relayDelivery, relayWireTo: wireRecipient, relayPayload: { from: sender, to, body, timestamp: senderTimestamp ?? timestamp }, receivedAt: timestamp } : {}),
  };

  const safeTs = timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  const tmpPath = join(inbox.tmp, filename);
  const newPath = join(inbox.fresh, filename);
  writeFileSync(tmpPath, JSON.stringify(message, null, 2), { encoding: "utf-8", flag: "wx" });
  if (relayDelivery) publishRelayedRecord(tmpPath, newPath);
  else renameSync(tmpPath, newPath);

  logEvent({ event: "sent", from: sender, to, messageId: id }, body);

  return { ...message, filePath: newPath };
}

// ─── Promotion: the ONE enforcement point (new/ → cur/) ──────────────────────
//
// `new/` is never mail; only `cur/` is presentable. Verification is NOT
// optional: there is no FlairClient parameter anywhere on this path — optional
// verification is exactly how it rotted (the shipped verifier was dead because
// the only live caller passed two arguments and the client was the third).
//
// Reject classes: `verify-unavailable` is RETRYABLE (a Flair outage quarantines
// inbound until Flair returns, then self-heals on a later check); the rest are
// terminal. All rejections dead-letter to dlq/ with a `<file>.reason` sidecar —
// ONE convention (the CLI used to write `.reject`, which the daily surfacing
// never saw).
//
// `unresolvable-principal` is the topology verdict, distinct from forgery: an
// agent-kind chain entry or `envelope.from` that this mailbox's LOCAL Flair does
// not hold. It is TERMINAL and — enforced, not merely intended — it carries the
// SAME severity as `invalid`: it is not in RETRYABLE_REJECT_CLASSES and it
// surfaces on the same dlq path, so an alert wired to `class == "invalid"` cannot
// be silently bypassed by it (see the no-downgrade drill). Keep the two names
// distinct and keep this one terminal: a retryable that cannot heal locally is
// fail-stuck, and any expected-but-not-yet-synced class (Option 1) is a SEPARATE,
// retryable name — never this one (cli#383).

export type PromoteRejectClass =
  | "invalid"
  | "unresolvable-principal"
  | "wrong-recipient"
  | "replay"
  | "verify-unavailable"
  | "storage-unavailable"
  | "unverified"
  | "busy"
  | "inbox-full";

/**
 * Reject classes a later check will re-drive. `verify-unavailable` (a Flair
 * outage) and `storage-unavailable` (a transient disk/write fault) are both
 * RETRYABLE: the inbound is quarantined rather than dropped, and the next
 * `mail check` re-drives it until the fault clears. Everything else is
 * terminal and is never retried.
 */
// Exported so the no-downgrade drill can assert membership DIRECTLY: the pin is
// that `unresolvable-principal` is absent here (i.e. it can never be re-driven),
// exactly as `invalid` is. Adding it to this set is the downgrade the drill exists
// to fail on.
export const RETRYABLE_REJECT_CLASSES: ReadonlySet<PromoteRejectClass> = new Set([
  "verify-unavailable",
  "storage-unavailable",
  "busy",
  "inbox-full",
]);

export interface PromoteOk {
  ok: true;
  message: MailMessage;
  path: string;
}
export interface PromoteReject {
  ok: false;
  class: PromoteRejectClass;
  reason: string;
}
export type PromoteResult = PromoteOk | PromoteReject;

const REASON_CLASS_RE = /^class:\s*(\S+)/m;

/**
 * Write the dlq sidecar. First line is `class: <class>` so a retry pass can
 * find retryable (`verify-unavailable`) entries without re-verifying.
 */
function writeReasonSidecar(dlqDir: string, filename: string, cls: PromoteRejectClass, reason: string): void {
  writeFileSync(
    join(dlqDir, `${filename}.reason`),
    `class: ${cls}\nPromote rejected at ${new Date().toISOString()}\nReason: ${reason}\n`,
    "utf-8",
  );
}

/** Read the class + reason from a dlq sidecar, if present. */
function readReasonSidecar(dlqDir: string, filename: string): { cls: PromoteRejectClass; reason: string } | null {
  try {
    const raw = readFileSync(join(dlqDir, `${filename}.reason`), "utf-8");
    const m = raw.match(REASON_CLASS_RE);
    const cls = (m ? m[1] : "invalid") as PromoteRejectClass;
    return { cls, reason: raw.trim() };
  } catch {
    return null;
  }
}

export function deadLetterUndelivered(
  agent: string,
  record: { id: string; from: string; to: string; body: string; timestamp: string },
  cls: PromoteRejectClass,
  reason: string,
  relayDelivery?: { branchId: string; id: string },
): string {
  validateMessageId(record.id);
  let inbox: { tmp: string; dlq: string };
  try {
    assertValidAgentId(agent);
    inbox = getInbox(agent);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("Invalid agent id"))) throw error;
    inbox = { tmp: join(getMailDir(), ".undeliverable", "tmp"), dlq: join(getMailDir(), ".undeliverable", "dlq") };
    mkdirMailDirectory(inbox.tmp);
    mkdirMailDirectory(inbox.dlq);
  }
  const safeTs = record.timestamp.replace(/[^0-9A-Za-z_-]/g, "-");
  const filename = `${safeTs}-${record.id}-${randomUUID()}.json`;
  const tmpPath = join(inbox.tmp, filename);
  writeFileSync(tmpPath, JSON.stringify({ ...record, read: false, ...(relayDelivery ? { relayDelivery, relayPayload: { from: record.from, to: record.to, body: record.body, timestamp: record.timestamp }, receivedAt: new Date().toISOString() } : {}) }, null, 2), "utf-8");
  writeReasonSidecar(inbox.dlq, filename, cls, reason);
  if (relayDelivery) {
    syncMailFile(join(inbox.dlq, `${filename}.reason`));
    publishRelayedRecord(tmpPath, join(inbox.dlq, filename));
  } else renameSync(tmpPath, join(inbox.dlq, filename));
  return join(inbox.dlq, filename);
}

/**
 * Dead-letter a record to dlq/ with a `.reason` sidecar. Works from new/, tmp/
 * or dlq/ (re-rejection updates the sidecar in place). Derives the sibling
 * directories from the record's own path, so promotion is correct for ANY mail
 * root (the plugin passes its own configured mailDir, not TPS_MAIL_DIR).
 */
function rejectToDlq(
  dirs: { fresh: string; tmp: string; cur: string; dlq: string },
  filename: string,
  sourcePath: string,
  cls: PromoteRejectClass,
  reason: string,
): void {
  try {
    mkdirSync(dirs.dlq, { recursive: true });
    const target = join(dirs.dlq, filename);
    if (sourcePath !== target && existsSync(sourcePath)) renameSync(sourcePath, target);
    writeReasonSidecar(dirs.dlq, filename, cls, reason);
  } catch (err: any) {
    console.error(`[mail] failed to dead-letter ${filename}: ${err?.message ?? err}`);
  }
}

export function mailRootForRecordPath(filePath: string): string {
  return dirname(dirsForRecordPath(filePath).root);
}

/** The new/tmp/cur/dlq siblings of a record at <root>/<dir>/<file>. */
function dirsForRecordPath(filePath: string): { root: string; fresh: string; tmp: string; cur: string; dlq: string } {
  const root = dirname(dirname(filePath));
  return {
    root,
    fresh: join(root, "new"),
    tmp: join(root, "tmp"),
    cur: join(root, "cur"),
    dlq: join(root, "dlq"),
  };
}

/** Replay lookup for a reader that does not hold the mailbox lock (mail watch); see peekConsumedForMailboxRoot. */
export function isConsumedForMailbox(agent: string, messageId: string): boolean {
  return peekConsumedForMailboxRoot(mailboxRoot(agent), messageId);
}

type EnvelopeBinding =
  | { kind: "bind"; recordField: keyof MailMessage }
  | { kind: "exclude"; reason: string };

/**
 * How each `Envelope` field binds to the outer mail record — the ONE list, so a
 * field cannot be left unbound by oversight. `satisfies Record<keyof Envelope,
 * EnvelopeBinding>` makes adding a field to `Envelope` a BUILD failure until
 * someone decides what it binds to (the CLI tsconfig typechecks src/, not tests,
 * so this lives in production code on purpose).
 *
 * It is a MAPPING, not same-name equality: `messageId` binds to the record's
 * `envelopeId`.
 */
export const ENVELOPE_BINDINGS = {
  v: { kind: "exclude", reason: "version is validated (verifyEnvelope requires v === 1)" },
  from: { kind: "bind", recordField: "from" },
  to: { kind: "bind", recordField: "to" },
  subject: { kind: "exclude", reason: "not carried on the outer record" },
  body: { kind: "bind", recordField: "body" },
  trust: { kind: "exclude", reason: "authority is signed inside the envelope, not copied to the record" },
  messageId: { kind: "bind", recordField: "envelopeId" },
  timestamp: { kind: "bind", recordField: "timestamp" },
  replyToId: { kind: "bind", recordField: "replyToId" },
  delegationChain: { kind: "exclude", reason: "signed as part of the envelope and verified" },
  signature: { kind: "exclude", reason: "verified by decideEnvelopeForMailbox" },
} satisfies Record<keyof Envelope, EnvelopeBinding>;

/**
 * Check the record↔envelope binding using the table above. Returns the first
 * mismatch (or ok). Both recovery paths call this, so the bound set is defined
 * once.
 */
function recordMatchesEnvelope(
  record: MailMessage,
  envelope: Envelope,
): { ok: true } | { ok: false; reason: string } {
  for (const key of Object.keys(ENVELOPE_BINDINGS) as Array<keyof typeof ENVELOPE_BINDINGS>) {
    const rule = ENVELOPE_BINDINGS[key];
    if (rule.kind !== "bind") continue;
    const envValue = envelope[key];
    const recValue = record[rule.recordField];
    if (envValue !== recValue) {
      return {
        ok: false,
        reason: `binding mismatch on envelope.${String(key)} (record.${String(rule.recordField)})`,
      };
    }
  }
  return { ok: true };
}

/**
 * The fields an UNVERIFIED record may still show (cli#429): the wrapper's
 * identity claims (id, from, to, timestamp — shown as claims, never as mail),
 * where the record sits and why (location, dlq reject class and reason, which
 * this CLI writes), and the local lifecycle fields `mail list --status`
 * classifies by. An ALLOWLIST, not a blocklist: everything else on the record
 * is dropped, so a thread claim needs no name here to be withheld.
 */
const UNVERIFIED_PRESENTABLE_FIELDS = [
  "id",
  "from",
  "to",
  "timestamp",
  "receivedAt",
  "read",
  "location",
  "rejectClass",
  "rejectReason",
  "ackedAt",
  "nackedAt",
  "nackType",
  "checkedOutAt",
  "checkedOutBy",
  "deliveryAttempts",
  "retryAfter",
] as const satisfies ReadonlyArray<keyof MailMessage>;

/**
 * The ONE redaction for an UNVERIFIED record (cli#429): a new/ record, a dlq/
 * record, or a cur/ record that cannot prove (and re-verify) its promotion.
 * Its body is withheld, and so is every field outside
 * UNVERIFIED_PRESENTABLE_FIELDS — among them the THREAD fields (`replyToId`,
 * the `envelopeId` a reply would thread on, the stored `envelope`), its
 * `headers` (every header on an unverified record is an unverified claim, and
 * `X-TPS-InReplyTo`, `X-TPS-Obligation` and `X-TPS-Nack` are thread claims),
 * and any other field the file carries (a bridge record's `obligationId` /
 * `replyId`, for one). Every presentation of an unverified record
 * (listMessages, `mail list` text and JSON, `mail read` text and JSON) goes
 * through this, so a forged thread claim is never shown. Returns a copy; the
 * input is not modified.
 */
export function withholdUnverified(m: MailMessage): MailMessage {
  const out: Record<string, unknown> = {};
  for (const field of UNVERIFIED_PRESENTABLE_FIELDS) {
    if (m[field] !== undefined) out[field] = m[field];
  }
  return { ...(out as Omit<MailMessage, "body">), body: "" } as MailMessage;
}

type EnvelopePolicyResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; class: PromoteRejectClass; reason: string };

/** Non-bridge claims must use these values; bridge claims always map to external. */
const VALID_SIGNED_TRUST: ReadonlySet<string> = new Set(["user", "internal", "external"]);

function trustCeilingReject(
  envelope: Envelope,
  mailRoot: string,
  verify: MailVerifyConfig,
): { ok: false; class: PromoteRejectClass; reason: string } | null {
  const trust = (envelope as { trust?: unknown }).trust;
  if (bridgePrincipalIds(mailRoot, verify.bridgeAgentId).has(envelope.from)) return null;
  if (trust !== undefined && !VALID_SIGNED_TRUST.has(trust as string)) {
    const shown =
      typeof trust === "string"
        ? trust.length === 0
          ? "an empty string"
          : `a ${trust.length}-char string outside the rule`
        : trust === null
          ? "null"
          : typeof trust;
    return {
      ok: false,
      class: "invalid",
      reason: `invalid trust value (must be "user", "internal" or "external"; got ${shown})`,
    };
  }
  return null;
}

/**
 * The ONE mailbox decision (@tpsdev-ai/agent decideEnvelopeForMailbox), through
 * an ALWAYS-constructed Flair client.
 */
async function decideEnvelopeForMailbox(
  agent: string,
  envelope: Envelope,
  wrapperFrom: string,
  mailRoot: string,
  verify: MailVerifyConfig = {},
): Promise<EnvelopePolicyResult> {
  const decision = await decideEnvelope(agent, envelope, wrapperFrom, await createMailVerifyClient(agent, verify))
    .catch((err: unknown) => {
      if (err instanceof PublicKeyFormatError) {
        return { ok: false as const, class: "invalid" as const, reason: `signature verification failed: ${err.message}` };
      }
      throw err;
    });
  if (!decision.ok) return decision;
  return trustCeilingReject(decision.envelope, mailRoot, verify) ?? decision;
}

export type VerifyRecordResult =
  | { ok: true; message: MailMessage }
  | { ok: false; class: PromoteRejectClass; reason: string };

/**
 * Verify ONE record IN PLACE: the checks `promote()` applies to a `new/`
 * record — the inner signed envelope, plus the shared `decideEnvelopeForMailbox`
 * bindings (the wrapper SENDER against the signed sender, and the signed
 * recipient against the mailbox; not every wrapper field is compared). It moves,
 * leases and writes NOTHING.
 *
 * Returns the verified message, or the refusal class and reason. Throws on a
 * verification ERROR — Flair unreachable, or a malformed envelope structure —
 * which callers withhold and retry, not a verdict.
 */
export async function verifyRecordForMailbox(
  agent: string,
  record: MailMessage,
  mailRoot: string,
  verify: MailVerifyConfig = {},
): Promise<VerifyRecordResult> {
  const parsed = parseSignedEnvelope(record.body);
  if (!parsed.ok) return parsed;
  const envelope = parsed.envelope;
  const decision = await decideEnvelopeForMailbox(agent, envelope, record.from, mailRoot, verify);
  if (!decision.ok) return { ok: false, class: decision.class, reason: decision.reason };
  return {
    ok: true,
    message: {
      ...record,
      from: envelope.from,
      to: envelope.to,
      body: envelope.body,
      timestamp: envelope.timestamp,
      read: false,
      envelopeId: envelope.messageId,
      envelope,
      trustTier: verifiedMailTier(envelope, mailRoot, verify.bridgeAgentId),
      replyToId: envelope.replyToId,
    },
  };
}

/**
 * THE enforcer. Move one record to cur/ ONLY if its envelope verifies AND is
 * addressed to this mailbox AND has not already been consumed. Otherwise
 * dead-letter it to dlq/ with a `.reason` sidecar.
 *
 * Accepts a source path in new/, tmp/ or dlq/ (so a quarantined
 * verify-unavailable entry can be re-driven through the same function).
 *
 * Deliberately does NOT retro-verify cur/ or the archive.
 */
export async function promote(agent: string, filePath: string, verify: MailVerifyConfig = {}): Promise<PromoteResult> {
  assertValidAgentId(agent);
  const dirs = dirsForRecordPath(filePath);
  const mailRoot = mailRootForRecordPath(filePath);
  const filename = filePath.split("/").pop()!;

  // Step 0: read the wrapper.
  let msg: MailMessage;
  try {
    msg = readMessageFile(filePath);
  } catch (err: any) {
    const reason = `json parse error: ${err?.message ?? String(err)}`;
    rejectToDlq(dirs, filename, filePath, "invalid", reason);
    return { ok: false, class: "invalid", reason };
  }

  // Step 1+2: the SHARED record verification (parse the envelope, and run the
  // ONE mailbox policy: signature, wrapper-sender↔signed-sender binding,
  // recipient binding, messageId/replyToId shapes, timestamp shape). The wrapper
  // was parsed above.
  // This is the SAME function the non-consuming `mail watch` reader calls, so
  // the two cannot diverge. `promote` adds the move below.
  let verified: VerifyRecordResult;
  try {
    verified = await verifyRecordForMailbox(agent, msg, mailRoot, verify);
  } catch (err: any) {
    // Flair did not answer — RETRYABLE, not terminal. Quarantine it and let a
    // later check re-drive it, so an outage self-heals when Flair returns.
    const reason = `verification unavailable: ${err?.message ?? String(err)}`;
    rejectToDlq(dirs, filename, filePath, "verify-unavailable", reason);
    return { ok: false, class: "verify-unavailable", reason };
  }
  if (!verified.ok) {
    rejectToDlq(dirs, filename, filePath, verified.class, verified.reason);
    return { ok: false, class: verified.class, reason: verified.reason };
  }
  const envelope = verified.message.envelope as Envelope;

  // Step 3: acquire the per-mailbox lock. It spans the replay check AND the
  // promotion commit/rollback (the ledger prune and append included): two
  // concurrent promotions must not both pass the replay gate before either
  // records the id, and a prune must not lose a concurrent append. The network
  // verification above deliberately ran BEFORE the lock.
  let lock: MailLock | null;
  try {
    lock = await acquireMailLock(dirs.root, { timeoutMs: 0 });
  } catch (err: any) {
    // Nested acquisition is a programming error, not a delivery decision.
    return { ok: false, class: "busy", reason: `mail lock error: ${err?.message ?? String(err)}` };
  }
  if (!lock) {
    return { ok: false, class: "busy", reason: "mailbox lock busy; not delivered" };
  }

  try {
    // Revalidate the source under the lock: a concurrent checker may have
    // promoted or replaced it between our verification and our acquisition.
    let current: MailMessage;
    try {
      current = readMessageFile(filePath);
    } catch {
      return { ok: false, class: "busy", reason: "source became unreadable during promotion; retry" };
    }
    if (current.body !== msg.body || current.from !== msg.from || current.timestamp !== msg.timestamp) {
      return { ok: false, class: "busy", reason: "source changed during promotion; retry" };
    }

    // Step 4 (first-delivery only): replay — a re-planted consumed envelope must
    // dead-letter. Consulted against the DURABLE ledger (and the maildir
    // fallback), not cur/ alone. The ledger prune runs here, under the lock.
    const replay = mailboxReplayStore(dirs.root);
    const curPath = join(dirs.cur, filename);
    let consumed: boolean;
    try {
      consumed = replay.isConsumed(envelope.messageId);
    } catch (err: any) {
      const reason = `replay history unavailable: ${err?.message ?? String(err)}`;
      rejectToDlq(dirs, filename, filePath, "storage-unavailable", reason);
      return { ok: false, class: "storage-unavailable", reason };
    }
    if (consumed) {
      const reason = `replay (envelope messageId ${envelope.messageId} already consumed)`;
      rejectToDlq(dirs, filename, filePath, "replay", reason);
      return { ok: false, class: "replay", reason };
    }

    // Step 5: atomic → cur/ with verified metadata.
    //
    // Append commits the cur/ copy; source removal is subsequent cleanup.
    const promoted: MailMessage = {
      ...msg,
      from: envelope.from,
      to: envelope.to,
      body: envelope.body,
      timestamp: envelope.timestamp,
      read: false,
      ackedAt: undefined,
      bridgeSentAt: undefined,
      envelopeId: envelope.messageId,
      envelope,
      trustTier: verifiedMailTier(envelope, mailRoot, verify.bridgeAgentId),
      // Stamp the verified reply-to (or clear it): the binding table checks
      // record.replyToId against envelope.replyToId, so presentation cannot
      // show a reply-to that is not the one that was signed.
      replyToId: envelope.replyToId,
      checkedOutAt: new Date().toISOString(),
      checkedOutBy: msg.checkedOutBy ?? agent,
      deliveryAttempts: (msg.deliveryAttempts ?? 0) + 1,
    };
    const scratchPath = join(dirs.tmp, `${filename}.${randomUUID()}.promote`);
    let scratchCreated = false;
    let movedToCur = false;
    try {
      mkdirSync(dirs.tmp, { recursive: true });
      mkdirSync(dirs.cur, { recursive: true });
      writeFileSync(scratchPath, JSON.stringify(promoted, null, 2), { encoding: "utf-8", flag: "wx" });
      scratchCreated = true;
      const placement = placeCurRecord(scratchPath, curPath);
      if (placement.status !== "placed") {
        throw new Error(`destination already exists: ${filename}`);
      }
      movedToCur = true;
      rmSync(scratchPath, { force: true });
      replay.recordConsumed(envelope.messageId);
    } catch (err: any) {
      // Cleanup must never itself throw. A real fault (ENOSPC, an unwritable or
      // non-file entry at the scratch path) is expected to persist so a later
      // check can re-drive it; a transient one is cleared here and self-heals.
      try {
        if (scratchCreated) rmSync(scratchPath, { force: true });
      } catch {
        /* fault persists — re-drivable */
      }
      if (movedToCur) {
        try {
          rmSync(curPath, { force: true });
        } catch {
          /* best effort */
        }
      }
      const reason = `storage failure during promote: ${err?.message ?? String(err)}`;
      rejectToDlq(dirs, filename, filePath, "storage-unavailable", reason);
      return { ok: false, class: "storage-unavailable", reason };
    }

    try {
      rmSync(filePath, { force: true });
    } catch {}

    // Success: clear any stale sidecar from a prior quarantine (best-effort
    // cleanup; cannot undo the promotion above).
    try {
      const staleReason = join(dirs.dlq, `${filename}.reason`);
      if (existsSync(staleReason)) rmSync(staleReason, { force: true });
    } catch {
      // best effort
    }

    logEvent({ event: "read", from: promoted.from, to: agent, messageId: promoted.id, replyToId: promoted.replyToId }, promoted.body);
    return { ok: true, message: promoted, path: curPath };
  } finally {
    lock.release();
  }
}

/**
 * Re-drive every dlq/ entry whose sidecar class is RETRYABLE through promote().
 * Returns the entries it promoted.
 */
export async function redriveRetryable(agent: string, dlqDir: string, verify: MailVerifyConfig = {}): Promise<PromoteOk[]> {
  const promoted: PromoteOk[] = [];
  for (const f of listMessageFiles(dlqDir)) {
    const side = readReasonSidecar(dlqDir, f);
    if (!side || !RETRYABLE_REJECT_CLASSES.has(side.cls)) continue;
    const result = await promote(agent, join(dlqDir, f), verify);
    if (result.ok) promoted.push(result);
  }
  return promoted;
}

/**
 * Unlink stranded `tmp/*.promote` scratch, including links shared with cur/.
 */
export async function sweepStrandedPromoteScratch(root: string): Promise<number> {
  const tmpDir = join(root, "tmp");
  if (!existsSync(tmpDir)) return 0;
  // Coordinate with in-flight promotions: hold the SAME lock promote() holds, so
  // a scratch being composed right now cannot be eaten (an age guard is cleanup
  // policy, not the safety property — a paused promoter outlives any threshold,
  // and stat-then-delete still races with replacement of the same pathname).
  let lock: MailLock | null;
  try {
    lock = await acquireMailLock(root, { timeoutMs: 0 });
  } catch {
    return 0;
  }
  if (!lock) return 0;
  try {
    let removed = 0;
    for (const name of readdirSync(tmpDir)) {
      if (!name.endsWith(".promote")) continue;
      try {
        rmSync(join(tmpDir, name), { force: true, recursive: true });
        removed++;
      } catch {
        /* best effort — retried on the next sweep */
      }
    }
    return removed;
  } finally {
    lock.release();
  }
}

/**
 * Read-only provenance + policy check for a record already in `cur/`.
 *
 * This is the SAME bar the first-delivery path sets, reused so presentation,
 * crash recovery and the lease sweep cannot diverge: the record must carry the
 * `envelopeId` AND the signed `envelope` that `promote()` stamps (a self-asserted
 * id is not proof — a forger sets it), the record must match the envelope per
 * the binding table, and the envelope must verify through the shared policy
 * (signature, wrapper->envelope from, recipient, messageId, timestamp).
 *
 */
async function checkPromotedRecord(agent: string, record: MailMessage, mailRoot: string, verify: MailVerifyConfig = {}, root = mailboxRoot(agent)): Promise<EnvelopePolicyResult> {
  // Provenance: only promote() stamps envelopeId + the signed envelope.
  if (typeof record.envelopeId !== "string" || record.envelopeId.trim() === "") {
    return { ok: false, class: "unverified", reason: "record has no envelopeId (did not come through promotion)" };
  }
  const env = record.envelope as Envelope | undefined;
  if (!env || typeof env !== "object") {
    return { ok: false, class: "unverified", reason: "record is missing its stored signed envelope" };
  }
  const binding = recordMatchesEnvelope(record, env);
  if (!binding.ok) {
    return { ok: false, class: "unverified", reason: `record does not match its verified envelope: ${binding.reason}` };
  }
  const decision = await decideEnvelopeForMailbox(agent, env, record.from, mailRoot, verify);
  if (!decision.ok) return decision;
  if (!hasCommittedMessageId(root, env.messageId)) {
    throw new Error("promotion has no consumed ledger commit; not presented");
  }
  return decision;
}

/**
 * May a `cur/` record's body be presented? True only when it proves promotion
 * and re-verifies (see checkPromotedRecord). Any failure — including a Flair
 * outage — withholds the body (fail-closed).
 */
export async function isPresentableCurRecord(agent: string, record: MailMessage, mailRoot: string, verify: MailVerifyConfig = {}): Promise<boolean> {
  try {
    const decision = await checkPromotedRecord(agent, record, mailRoot, verify);
    if (!decision.ok) return false;
    record.trustTier = verifiedMailTier(decision.envelope, mailRoot, verify.bridgeAgentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-verify a `cur/` record that is about to be RE-PRESENTED (crash recovery or
 * the lease sweep).
 *
 * `cur/` is a DESTINATION directory; the enforcement point runs on the SOURCE.
 * Re-presenting from `cur/` therefore bypasses promotion unless the record
 * proves provenance AND re-verifies. Proof is `envelopeId` plus the stored
 * signed `envelope` — both set ONLY by `promote()`. A record that cannot prove
 * it was promoted, or that fails re-verification through the same
 * always-constructed Flair client, is QUARANTINED, not presented. Grandfathering
 * stays for history (cur/ and archive are never swept as mail); LIVE
 * re-delivery is held to the same bar as first delivery.
 *
 */
export async function recoverPromoted(agent: string, curPath: string, verify: MailVerifyConfig = {}): Promise<PromoteReject | (PromoteOk & { snapshot: MailMessage })> {
  assertValidAgentId(agent);
  const dirs = dirsForRecordPath(curPath);
  const mailRoot = mailRootForRecordPath(curPath);
  const filename = curPath.split("/").pop()!;

  let msg: MailMessage;
  try {
    msg = readMessageFile(curPath);
  } catch (err: any) {
    const reason = `corrupt cur/ record: ${err?.message ?? String(err)}`;
    if (err?.code !== "ENOENT") {
      const lock = acquireMailLockSync(dirs.root, { timeoutMs: 0 });
      if (!lock) return { ok: false, class: "busy", reason: "mailbox lock busy; not delivered" };
      try {
        try { readMessageFile(curPath); } catch (freshError: any) {
          if (freshError?.code !== "ENOENT") rejectToDlq(dirs, filename, curPath, "unverified", reason);
        }
      } finally { lock.release(); }
    }
    return { ok: false, class: "unverified", reason };
  }

  // Provenance + binding + policy, via the ONE shared check — so a record that
  // cannot prove promotion, or that does not re-verify, is not presented. This
  // includes the recipient binding, so a record carrying another mailbox's
  // genuine envelope cannot be presented here. (The first-delivery-only replay
  // gate is unnecessary: this id is already consumed.)
  const decision = await checkPromotedRecord(agent, msg, mailRoot, verify, dirs.root);
  if (!decision.ok) {
    const lock = acquireMailLockSync(dirs.root, { timeoutMs: 0 });
    if (!lock) return { ok: false, class: "busy", reason: "mailbox lock busy; not delivered" };
    try {
      try {
        if (JSON.stringify(readMessageFile(curPath)) === JSON.stringify(msg))
          rejectToDlq(dirs, filename, curPath, decision.class, decision.reason);
      } catch (err: any) { if (err?.code !== "ENOENT") throw err; }
    } finally { lock.release(); }
    return { ok: false, class: decision.class, reason: decision.reason };
  }
  const env = decision.envelope;

  // Present the fields from the VERIFIED envelope, not the mutable record —
  // the same fields the first-delivery path presents.
  const presented: MailMessage = {
    ...msg,
    from: env.from,
    to: env.to,
    body: env.body,
    timestamp: env.timestamp,
    envelopeId: env.messageId,
    trustTier: verifiedMailTier(env, mailRoot, verify.bridgeAgentId),
    replyToId: env.replyToId,
  };
  return { ok: true, message: presented, path: curPath, snapshot: msg };
}

/**
 * Check inbox: promote every new/ message through promote() (the one
 * enforcement point), re-drive quarantined verify-unavailable entries so an
 * outage self-heals, then lease-sweep cur/.
 *
 * Verification is mandatory — there is NO client parameter.
 */
export async function checkMessages(agent: string, checkedOutBy = agent, verify: MailVerifyConfig = {}): Promise<MailMessage[]> {
  assertValidAgentId(agent);
  assertValidAgentId(checkedOutBy);
  const inbox = getInbox(agent);

  try {
    archiveOldCur(agent);
  } catch (e: any) {
    // Non-fatal: archive failure must never block mail processing. Log so
    // operators can see ENOSPC, permissions, or other persistent issues
    // rather than silently letting cur/ grow forever. (K&S #295 follow-up.)
    console.warn(`[mail] archiveOldCur(${agent}) failed: ${e?.message ?? e}`);
  }

  // Reap stranded `tmp/*.promote` scratch from an interrupted promote — the
  // catch only runs on a thrown error, so a kill leaves orphans no other sweep
  // can see.
  try {
    await sweepStrandedPromoteScratch(inbox.root);
  } catch {
    /* best effort */
  }

  const messages: MailMessage[] = [];
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  // 1. Promote new/ → cur/ through the single enforcement point.
  for (const f of listMessageFiles(inbox.fresh)) {
    const result = await promote(agent, join(inbox.fresh, f), verify);
    if (result.ok) messages.push(result.message);
  }

  // 2. Self-heal: re-drive quarantined RETRYABLE entries (a Flair outage or a
  //    transient storage fault). Terminal rejects (invalid/wrong-recipient/
  //    replay) are NOT retried.
  for (const result of await redriveRetryable(agent, inbox.dlq, verify)) messages.push(result.message);

  // 3. Lease sweep over cur/ — re-present un-acked records past their lease.
  //    cur/ is a DESTINATION, so this is LIVE delivery and goes through the same
  //    bar as promotion: require proof of promotion (envelopeId) AND re-verify
  //    before presenting. A record that cannot prove provenance, or fails
  //    re-verification, is quarantined, not shown. Acked history never reaches
  //    this branch.
  for (const f of listMessageFiles(inbox.cur)) {
    const full = join(inbox.cur, f);
    let msg: MailMessage;
    try { msg = readMessageFile(full); } catch { continue; }
    if (msg.read || msg.nackedAt) continue;
    if (msg.retryAfter && Date.parse(msg.retryAfter) > nowMs) continue;
    if (msg.checkedOutBy && !isLeaseExpired(msg, nowMs)) continue;
    let recovered: Awaited<ReturnType<typeof recoverPromoted>>;
    try {
      recovered = await recoverPromoted(agent, full, verify);
    } catch {
      // Flair unreachable — leave the record in cur/ and retry on a later check.
      continue;
    }
    if (!recovered.ok) continue; // quarantined
    const result = updateExistingRecord<MailMessage>(full, (fresh) => {
      if (fresh.read || fresh.ackedAt || fresh.nackedAt) return null;
      if (fresh.retryAfter && Date.parse(fresh.retryAfter) > nowMs) return null;
      if (fresh.checkedOutBy && !isLeaseExpired(fresh, nowMs)) return null;
      return Object.assign(fresh, recovered.message, { checkedOutAt: nowIso, checkedOutBy });
    }, { snapshot: recovered.snapshot, nonBlocking: true });
    if (result.status === "updated") messages.push(result.record);
  }

  // Best-effort GC: purge acked/expired messages older than 24h on every check
  try { gcMessages(agent); } catch { /* never block delivery */ }

  return messages.sort((a, b) => ((a.receivedAt ?? a.timestamp) < (b.receivedAt ?? b.timestamp) ? 1 : -1));
}

export async function listMessages(agent: string): Promise<MailMessage[]> {
  assertValidAgentId(agent);
  const inbox = getInbox(agent);
  // new/ is unverified and dlq/ is quarantined: neither is presentable mail, so
  // both are withheld — body AND thread fields (cli#429).
  const unread = readMessagesFromDir(inbox.fresh, false, "new").map(withholdUnverified);
  const dlq = readMessagesFromDir(inbox.dlq, true, "dlq").map(withholdUnverified);
  // Only a record that PROVES its promotion and re-verifies is presentable from
  // cur/. A self-asserted `envelopeId` is not proof — a forger sets it — so the
  // stored signed envelope is re-checked through the shared policy. Any failure
  // (including an outage) withholds the record like new/ and dlq/.
  const cur: MailMessage[] = [];
  for (const file of listMessageFiles(inbox.cur)) {
    const path = join(inbox.cur, file);
    try {
      const m = readMessageFile(path);
      m.read = true;
      m.location = "cur";
      cur.push((await isPresentableCurRecord(agent, m, mailRootForRecordPath(path))) ? m : withholdUnverified(m));
    } catch (err: any) {
      console.error(`[mail] skipping corrupt message ${file}: ${err.message}`);
    }
  }
  return [...unread, ...cur, ...dlq].sort((a, b) => ((a.receivedAt ?? a.timestamp) < (b.receivedAt ?? b.timestamp) ? 1 : -1));
}

export async function verifyMailAction(agent: string, id: string): Promise<MailMessage | null> {
  const path = messagePathById(agent, id);
  if (!path) return null;
  const record = readMessageFile(path);
  const result = dirname(path).endsWith("/cur")
    ? await recoverPromoted(agent, path)
    : await verifyRecordForMailbox(agent, record, mailRootForRecordPath(path));
  if (!result.ok) throw new Error(`mail action refused: ${result.reason}`);
  if (result.message.trustTier === "external") throw new Error("external-tier mail cannot be acknowledged or nacked by an internal consumer");
  return result.message;
}

export function ackMessage(agent: string, id: string, mailRoot?: string): MailMessage | null {
  const path = messagePathById(agent, id, mailRoot);
  if (!path) return null;
  return ackMessageAtPath(path);
}

export function setBridgeSentAtPath(path: string, sentAt: string): void {
  const result = updateExistingRecord<MailMessage>(path, (msg) => {
    msg.bridgeSentAt = sentAt;
    return msg;
  });
  if (result.status !== "updated") throw new Error(`ENOENT: mail record gone: ${path}`);
}

export function ackMessageAtPath(path: string): MailMessage {
  const result = updateExistingRecord<MailMessage>(path, (msg) => {
    msg.read = true;
    msg.ackedAt = new Date().toISOString();
    delete msg.nackedAt;
    delete msg.nackReason;
    delete msg.nackType;
    delete msg.checkedOutAt;
    delete msg.checkedOutBy;
    delete msg.retryAfter;
    return msg;
  }, { afterWrite: () => {
    // Remove the file from cur/ now that it's acked. There is NO ack audit trail
    // behind this: `logEvent()` writes to the mailbox `archive.db` (archive.ts),
    // whose event set is only "sent" | "read" | "listed" — there is no "ack"
    // event. No durable ack audit trail is guaranteed (if the unlink below fails,
    // the ackedAt marker written above stays in the file), and nothing binds an archive row to the record's
    // verification verdict or `envelopeId`. (Logging an event before the unlink
    // would be better, but it would not be an ack trail without an ack event type
    // and that binding — so the comment says what is true rather than claiming a
    // trail we do not have.)
    try { unlinkSync(path); } catch { /* best effort — don't fail ack if cleanup fails */ }
  } });
  if (result.status !== "updated") throw new Error(`ENOENT: mail record gone: ${path}`);
  return result.record;
}

export function nackMessage(agent: string, id: string, reason: string, type: "transient" | "agent" | "permanent" = "transient", retryAfter?: string): MailMessage | null {
  const path = messagePathById(agent, id);
  if (!path) return null;
  const result = updateExistingRecord<MailMessage>(path, (msg) => {
    if (msg.id !== id && !msg.id.startsWith(id)) return null;
    msg.read = false;
    msg.nackedAt = new Date().toISOString();
    msg.nackReason = reason;
    msg.nackType = type;
    delete msg.checkedOutAt;
    delete msg.checkedOutBy;
    if (type === "transient" && retryAfter) {
      msg.retryAfter = new Date(Date.now() + parseDurationMs(retryAfter, 60_000)).toISOString();
    } else {
      delete msg.retryAfter;
    }
    return msg;
  }, { afterWrite: () => {
    if (type === "permanent") {
      const target = join(getInbox(agent).dlq, path.split("/").pop()!);
      renameSync(path, target);
    }
  } });
  return result.status === "updated" ? result.record : null;
}

export function gcMessages(agent?: string, maxAge = "24h", prNumber?: number, hardTtl = "48h"): number {
  const agents = agent ? [agent] : (existsSync(getMailDir()) ? readdirSync(getMailDir()).filter((d) => existsSync(join(getMailDir(), d, "cur"))) : []);
  let removed = 0;
  const doneCutoff = Date.now() - parseDurationMs(maxAge, 24 * 60 * 60 * 1000);
  const hardCutoff = Date.now() - parseDurationMs(hardTtl, 48 * 60 * 60 * 1000);
  for (const a of agents) {
    const inbox = getInbox(a);
    const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
    if (!lock) continue;
    try {
      for (const dir of [inbox.fresh, inbox.cur, inbox.dlq]) {
        for (const file of listMessageFiles(dir)) {
          const full = join(dir, file);
          const msg = readMessageFile(full);
          const hardTs = Date.parse(msg.receivedAt ?? msg.timestamp);
          const ts = Math.max(hardTs, Date.parse(msg.ackedAt ?? msg.receivedAt ?? msg.timestamp));
          const done = msg.read && !!msg.ackedAt;
          const prMatch = prNumber == null || msg.prNumber === prNumber || msg.body.includes(`#${prNumber}`) || msg.body.includes(`PR #${prNumber}`);
          if (!prMatch) continue;
          if ((done && ts < doneCutoff) || hardTs < hardCutoff) {
            rmSync(full, { force: true });
            removed++;
          }
        }
      }
    } finally { lock.release(); }
  }
  return removed;
}
