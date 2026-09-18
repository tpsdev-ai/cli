import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { logEvent } from "./archive.js";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { createMailVerifyClient } from "./mail-verify.js";
import { acquireMailLock, type MailLock } from "./mail-lock.js";

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
  /** Set by listMessages(): which maildir the record came from. */
  location?: "new" | "cur" | "dlq";
  /** The verified envelope's messageId, persisted so replay is detectable. */
  envelopeId?: string;
  /**
   * The full SIGNED envelope, persisted at promotion so a later cur/ re-read
   * (crash recovery / lease sweep) can re-verify it. Binds "verified at
   * promote" to "presented at dispatch": a local tamper of the record between
   * the two either breaks this envelope's signature or fails the field match.
   */
  envelope?: Envelope;
  /** Set by listMessages() for dlq records: the sidecar reason class. */
  rejectClass?: string;
  rejectReason?: string;
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
  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
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
    throw new Error(inboxFullMessage(to, quotaCount));
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

export type PromoteRejectClass =
  | "invalid"
  | "wrong-recipient"
  | "replay"
  | "verify-unavailable"
  | "storage-unavailable"
  | "unverified"
  | "busy";

/**
 * Reject classes a later check will re-drive. `verify-unavailable` (a Flair
 * outage) and `storage-unavailable` (a transient disk/write fault) are both
 * RETRYABLE: the inbound is quarantined rather than dropped, and the next
 * `mail check` re-drives it until the fault clears. Everything else is
 * terminal and is never retried.
 */
const RETRYABLE_REJECT_CLASSES: ReadonlySet<PromoteRejectClass> = new Set([
  "verify-unavailable",
  "storage-unavailable",
  "busy",
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

/**
 * Try to parse a message body as a TPS v1 signed envelope.
 *
 * Returns the envelope object, or the string "json-parse-error" (not JSON) or
 * "missing-fields" (JSON but not a v1 envelope).
 */
function tryParseEnvelope(body: string): Record<string, unknown> | "json-parse-error" | "missing-fields" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "json-parse-error";
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "missing-fields";
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.v !== "number" ||
    !Array.isArray(obj.delegationChain) ||
    typeof obj.signature !== "string"
  ) {
    return "missing-fields";
  }

  return obj;
}

// ─── Durable consumed-id ledger (replay gate that survives maildir GC) ───────
//
// The replay gate must NOT be the maildir. cur/ is mutable — ackMessage unlinks
// the record, gcMessages purges it, and archiveOldCur rotates cur/ into
// archive/ — so a gate built on those reopens the moment a record ages out. A
// defence that expires is not a defence (CWE-294, replay).
//
// Consumed ids are therefore recorded in an append-only ledger at the mailbox
// root — OUTSIDE every directory the maildir maintenance touches — and consulted
// BEFORE promotion. The ledger is bounded by AGE, not by the maildir's
// contents, so it outlives the record it stands in for rather than ageing out
// with it.
//
// Retention (CONSUMED_LEDGER_RETENTION_MS): 180 days. This is deliberately many
// multiples of the longest maildir lifetime — cur/ holds ~30 days before
// archiveOldCur rotates it, and gcMessages purges acked records after 24h and
// everything after 48h — so a replay must now wait out the LEDGER's window, not
// the maildir's. The fix converts the pre-fix window (which reopened as soon as
// the record was acked or GC'd — hours) into one bounded by this retention. The
// residual exposure past the retention is acknowledged; it is strictly larger
// than the window it replaced, and it is a knob, not an accident.
const CONSUMED_LEDGER_FILE = "consumed.jsonl";
const CONSUMED_LEDGER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

function consumedLedgerPath(root: string): string {
  return join(root, CONSUMED_LEDGER_FILE);
}

/**
 * Append a consumed envelope messageId to the durable ledger.
 *
 * Called ONLY after the record is safely in cur/ — never before — so a failed
 * promotion cannot mark an id consumed and then reject the legitimate retry as
 * a replay.
 */
function recordConsumedMessageId(root: string, messageId: string): void {
  // THROWS on failure. The ledger write is part of the promotion COMMIT: if it
  // fails, the id is not recorded and is silently replayable, so promote()
  // rolls the move back and dead-letters as retryable rather than claiming
  // success. (Log-and-continue here was fail-open — delivery succeeding
  // silently was the bug.)
  mkdirSync(root, { recursive: true });
  appendFileSync(
    consumedLedgerPath(root),
    `${JSON.stringify({ id: messageId, at: new Date().toISOString() })}\n`,
    "utf-8",
  );
}

/**
 * Read the durable ledger, dropping entries older than the retention. Returns
 * the live id set. When pruning actually removed something the ledger is
 * rewritten in place (atomic replace) so the file stays bounded by age.
 */
function readConsumedLedger(root: string): Set<string> {
  const path = consumedLedgerPath(root);
  const ids = new Set<string>();
  if (!existsSync(path)) return ids;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return ids;
  }

  const cutoff = Date.now() - CONSUMED_LEDGER_RETENTION_MS;
  const kept: string[] = [];
  let pruned = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: { id?: unknown; at?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      // Torn/partial line from an interrupted append. Do NOT drop it — salvage
      // the id and keep the line. Dropping was fail-open: a consumed id became
      // forgotten. We cannot date it, so it is never pruned.
      const m = line.match(/"id"\s*:\s*"([^"]+)"/);
      if (m) ids.add(m[1]!);
      kept.push(line);
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      kept.push(line); // unknown shape — keep, never prune what we cannot read
      continue;
    }
    const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    if (Number.isNaN(at)) {
      // Corrupt/absent timestamp (torn append, clock skew). Keep the id — a
      // consumed id must never be forgotten because we could not date it.
      ids.add(id);
      kept.push(line);
      continue;
    }
    if (at < cutoff) {
      pruned++; // genuinely older than the retention — the intended age bound
      continue;
    }
    ids.add(id);
    kept.push(line);
  }

  if (pruned > 0) {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
      renameSync(tmp, path);
    } catch {
      // Pruning is housekeeping — non-fatal, retried on the next read.
    }
  }
  return ids;
}

/**
 * Has this envelope messageId already been consumed?
 *
 * The durable ledger is the authority (it survives maildir GC). The maildir
 * scan (cur/ + archive/, recursively) is kept as a MIGRATION fallback for
 * records consumed before this ledger existed — or by an older build — so an
 * upgrade does not open a window for records already on disk. Counts both the
 * persisted `envelopeId` and, for legacy records, a body that is itself a
 * signed envelope. This is the gate on replay of consumed history.
 */
function isConsumedMessageId(root: string, messageId: string): boolean {
  if (readConsumedLedger(root).has(messageId)) return true;

  const stack = [join(root, "cur"), join(root, "archive")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const msg = JSON.parse(readFileSync(full, "utf-8")) as MailMessage;
        if (msg.envelopeId === messageId) return true;
        const parsed = tryParseEnvelope(msg.body);
        if (parsed !== "json-parse-error" && parsed !== "missing-fields") {
          if ((parsed as { messageId?: unknown }).messageId === messageId) return true;
        }
      } catch {
        // skip corrupt records
      }
    }
  }
  return false;
}

type EnvelopePolicyResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; class: PromoteRejectClass; reason: string };

/**
 * The ONE mailbox decision for an enveloped record — the shared policy that BOTH
 * first delivery (`promote`) and re-presentation (`recoverPromoted`) run, so the
 * check set cannot diverge. Add a check here and both paths get it; there is no
 * second list to keep in sync.
 *
 * The checks, in order:
 *   1. signature, through an ALWAYS-constructed Flair client;
 *   2. wrapper/envelope `from` binding;
 *   3. recipient binding (`envelope.to === agent`);
 *   4. `messageId` shape (present, non-empty string).
 *
 * Callers add only their path-specific step: `promote` adds the replay gate
 * (first delivery only); `recoverPromoted` requires provenance (recovery only).
 *
 * Throws only when Flair is unreachable — a retryable outage, not a verdict.
 */
async function decideEnvelopeForMailbox(
  agent: string,
  envelope: Envelope,
  wrapperFrom: string,
): Promise<EnvelopePolicyResult> {
  // 1. Signature, through an ALWAYS-constructed client.
  const client = await createMailVerifyClient(agent);
  const verified = await verifyEnvelope(envelope, client);
  if (!verified.ok) {
    return { ok: false, class: "invalid", reason: `signature verification failed: ${verified.reason}` };
  }

  // 2. The wrapper `from` is what consumers route by, and it is unverified; a
  //    wrapper/envelope mismatch is itself a reject.
  if (wrapperFrom !== envelope.from) {
    return {
      ok: false,
      class: "invalid",
      reason: `wrapper/envelope from mismatch (wrapper.from=${wrapperFrom}, envelope.from=${envelope.from})`,
    };
  }

  // 3. The verified recipient must be this mailbox's owner.
  if (envelope.to !== agent) {
    return {
      ok: false,
      class: "wrong-recipient",
      reason: `wrong-recipient (envelope.to=${envelope.to}, mailbox=${agent})`,
    };
  }

  // 4. `messageId` shape — the replay gate keys on it, and verifyEnvelope does
  //    not enforce it. A malformed id is a terminal reject, not an undefined key
  //    that silently never matches.
  if (typeof envelope.messageId !== "string" || envelope.messageId.trim() === "") {
    const shown = typeof envelope.messageId === "string" ? JSON.stringify(envelope.messageId) : String(envelope.messageId);
    return {
      ok: false,
      class: "invalid",
      reason: `invalid messageId (must be a non-empty string, got ${shown})`,
    };
  }

  return { ok: true, envelope };
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
export async function promote(agent: string, filePath: string): Promise<PromoteResult> {
  assertValidAgentId(agent);
  const dirs = dirsForRecordPath(filePath);
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

  // Step 1: parse wrapper → parse envelope.
  const parsed = tryParseEnvelope(msg.body);
  if (parsed === "json-parse-error") {
    const reason = "body is not JSON (signed envelope required)";
    rejectToDlq(dirs, filename, filePath, "invalid", reason);
    return { ok: false, class: "invalid", reason };
  }
  if (parsed === "missing-fields") {
    const reason = "body is not a v1 signed envelope";
    rejectToDlq(dirs, filename, filePath, "invalid", reason);
    return { ok: false, class: "invalid", reason };
  }
  const envelope = parsed as unknown as Envelope;

  // Step 2: run the SHARED mailbox policy (signature, wrapper→envelope from
  // binding, recipient binding, messageId shape). This is the SAME list
  // recoverPromoted runs, so the two paths cannot diverge.
  let decision: EnvelopePolicyResult;
  try {
    decision = await decideEnvelopeForMailbox(agent, envelope, msg.from);
  } catch (err: any) {
    // Flair did not answer — RETRYABLE, not terminal. Quarantine it and let a
    // later check re-drive it, so an outage self-heals when Flair returns.
    const reason = `verification unavailable: ${err?.message ?? String(err)}`;
    rejectToDlq(dirs, filename, filePath, "verify-unavailable", reason);
    return { ok: false, class: "verify-unavailable", reason };
  }
  if (!decision.ok) {
    rejectToDlq(dirs, filename, filePath, decision.class, decision.reason);
    return { ok: false, class: decision.class, reason: decision.reason };
  }

  // Step 3: acquire the per-mailbox lock. It spans the replay check AND the
  // promotion commit/rollback (the ledger prune and append included): two
  // concurrent promotions must not both pass the replay gate before either
  // records the id, and a prune must not lose a concurrent append. The network
  // verification above deliberately ran BEFORE the lock.
  let lock: MailLock | null;
  try {
    lock = await acquireMailLock(dirs.root);
  } catch (err: any) {
    // Nested acquisition is a programming error, not a delivery decision.
    return { ok: false, class: "busy", reason: `mail lock error: ${err?.message ?? String(err)}` };
  }
  if (!lock) {
    // Could not acquire within the bound. Fail-closed: do NOT deliver; the
    // source stays in place for the next check.
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
    if (isConsumedMessageId(dirs.root, envelope.messageId)) {
      const reason = `replay (envelope messageId ${envelope.messageId} already consumed)`;
      rejectToDlq(dirs, filename, filePath, "replay", reason);
      return { ok: false, class: "replay", reason };
    }

    // Step 5: atomic → cur/ with verified metadata.
    //
    // The promoted record is composed in a SCRATCH file FIRST, and the source is
    // only removed once the promoted record is in cur/ AND the consumed id is
    // durably recorded. A failure in this block is a STORAGE fault, NOT a
    // verification verdict: the ORIGINAL bytes are never overwritten (a failed
    // scratch write never touches the source), so we preserve them, class it
    // RETRYABLE, and a later check re-drives it. The `envelope` is persisted so a
    // later cur/ re-read can re-verify (see recoverPromoted).
    const promoted: MailMessage = {
      ...msg,
      from: envelope.from,
      to: envelope.to,
      body: envelope.body,
      timestamp: envelope.timestamp,
      read: false,
      envelopeId: envelope.messageId,
      envelope,
      checkedOutAt: new Date().toISOString(),
      checkedOutBy: msg.checkedOutBy ?? agent,
      deliveryAttempts: (msg.deliveryAttempts ?? 0) + 1,
    };
    const curPath = join(dirs.cur, filename);
    const scratchPath = join(dirs.tmp, `${filename}.promote`);
    let movedToCur = false;
    try {
      mkdirSync(dirs.tmp, { recursive: true });
      mkdirSync(dirs.cur, { recursive: true });
      writeMessageFile(scratchPath, promoted);
      // Atomic into cur/.
      renameSync(scratchPath, curPath);
      movedToCur = true;
      // Record the consumed id durably as PART OF THE COMMIT. If this throws, the
      // move is rolled back below and the ORIGINAL is dead-lettered retryable — a
      // promotion that can't be recorded must not silently succeed (its id would
      // be replayable with no retry and no quarantine).
      recordConsumedMessageId(dirs.root, envelope.messageId);
      // Drop the source LAST, so a crash before here leaves the record in its
      // original directory (re-promoted, and caught by the replay gate) rather
      // than nowhere.
      rmSync(filePath, { force: true });
    } catch (err: any) {
      // Cleanup must never itself throw. A real fault (ENOSPC, an unwritable or
      // non-file entry at the scratch path) is expected to persist so a later
      // check can re-drive it; a transient one is cleared here and self-heals.
      try {
        rmSync(scratchPath, { force: true });
      } catch {
        /* fault persists — re-drivable */
      }
      if (movedToCur) {
        // Roll the commit back so the source (still intact) is the single copy.
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

    // Success: clear any stale sidecar from a prior quarantine (best-effort
    // cleanup; cannot undo the promotion above).
    try {
      const staleReason = join(dirs.dlq, `${filename}.reason`);
      if (existsSync(staleReason)) rmSync(staleReason, { force: true });
    } catch {
      // best effort
    }

    logEvent({ event: "read", from: promoted.from, to: agent, messageId: promoted.id }, promoted.body);
    return { ok: true, message: promoted, path: curPath };
  } finally {
    lock.release();
  }
}

/**
 * Remove stranded `tmp/<name>.json.promote` scratch files.
 *
 * A crash between composing the scratch and renaming it into cur/ leaves one
 * behind. The promote catch only runs on a THROWN error, not a kill, and
 * `listMessageFiles` filters `.endsWith(".json")`, so `.promote` orphans are
 * invisible to every sweep. They are always safe to remove: the rename into
 * cur/ deletes the scratch, so any surviving scratch is either incomplete or
 * still has its untouched source, which a later check re-promotes.
 */
export async function sweepStrandedPromoteScratch(root: string): Promise<number> {
  const tmpDir = join(root, "tmp");
  if (!existsSync(tmpDir)) return 0;
  // Coordinate with in-flight promotions: hold the SAME lock promote() holds, so
  // a scratch being composed right now cannot be eaten (an age guard is cleanup
  // policy, not the safety property — a paused promoter outlives any threshold,
  // and stat-then-delete still races with replacement of the same pathname). If
  // the lock is busy, a promoter is active, so nothing is stranded: skip.
  let lock: MailLock | null;
  try {
    lock = await acquireMailLock(root, { timeoutMs: 250 });
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
 * Throws only when Flair is unreachable — the caller should leave the record in
 * `cur/` and retry later (a transient outage is not a verdict about the mail).
 */
export async function recoverPromoted(agent: string, curPath: string): Promise<PromoteResult> {
  assertValidAgentId(agent);
  const dirs = dirsForRecordPath(curPath);
  const filename = curPath.split("/").pop()!;

  let msg: MailMessage;
  try {
    msg = readMessageFile(curPath);
  } catch (err: any) {
    const reason = `corrupt cur/ record: ${err?.message ?? String(err)}`;
    rejectToDlq(dirs, filename, curPath, "unverified", reason);
    return { ok: false, class: "unverified", reason };
  }

  // Provenance: only promote() stamps envelopeId. A cur/ record without it did
  // not come through the enforcement point — never present it.
  if (typeof msg.envelopeId !== "string" || msg.envelopeId.trim() === "") {
    const reason = "cur/ record has no envelopeId (did not come through promotion)";
    rejectToDlq(dirs, filename, curPath, "unverified", reason);
    return { ok: false, class: "unverified", reason };
  }

  // Binding: the envelope stored at promote() time must still describe THIS
  // record. Tampering with the record fails this match; tampering with the
  // envelope fails the signature check in the shared policy below. (The
  // wrapper→envelope `from` binding is part of the shared policy.)
  const env = msg.envelope as Envelope | undefined;
  if (
    !env || typeof env !== "object" ||
    env.messageId !== msg.envelopeId ||
    env.to !== msg.to || env.body !== msg.body
  ) {
    const reason = "cur/ record does not match its verified envelope (missing or tampered after promotion)";
    rejectToDlq(dirs, filename, curPath, "unverified", reason);
    return { ok: false, class: "unverified", reason };
  }

  // The SAME policy first delivery runs — recipient binding INCLUDED, so a
  // record carrying another mailbox's genuine envelope cannot be presented
  // here. The recovery-only extra (provenance) is above; the first-delivery
  // extra (replay gate) is unnecessary: this id is already consumed.
  const decision = await decideEnvelopeForMailbox(agent, env, msg.from);
  if (!decision.ok) {
    rejectToDlq(dirs, filename, curPath, decision.class, decision.reason);
    return { ok: false, class: decision.class, reason: decision.reason };
  }

  // Present the fields from the VERIFIED envelope, not the mutable record.
  const presented: MailMessage = {
    ...msg,
    from: env.from,
    to: env.to,
    body: env.body,
    envelopeId: env.messageId,
  };
  return { ok: true, message: presented, path: curPath };
}

/**
 * Check inbox: promote every new/ message through promote() (the one
 * enforcement point), re-drive quarantined verify-unavailable entries so an
 * outage self-heals, then lease-sweep cur/.
 *
 * Verification is mandatory — there is NO client parameter.
 */
export async function checkMessages(agent: string, checkedOutBy = agent): Promise<MailMessage[]> {
  assertValidAgentId(agent);
  assertValidAgentId(checkedOutBy);
  const inbox = getInbox(agent);

  // Opportunistic cur/ archive — keeps the processed tail from accumulating
  // indefinitely. Safe to no-op when there's nothing old; cost is one stat()
  // per cur entry, capped at the directory size.
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
    const result = await promote(agent, join(inbox.fresh, f));
    if (result.ok) messages.push(result.message);
  }

  // 2. Self-heal: re-drive quarantined RETRYABLE entries (a Flair outage or a
  //    transient storage fault). Terminal rejects (invalid/wrong-recipient/
  //    replay) are NOT retried.
  for (const f of listMessageFiles(inbox.dlq)) {
    const side = readReasonSidecar(inbox.dlq, f);
    if (!side || !RETRYABLE_REJECT_CLASSES.has(side.cls)) continue;
    const result = await promote(agent, join(inbox.dlq, f));
    if (result.ok) messages.push(result.message);
  }

  // 3. Lease sweep over cur/ — re-present un-acked records past their lease.
  //    cur/ is a DESTINATION, so this is LIVE delivery and goes through the same
  //    bar as promotion: require proof of promotion (envelopeId) AND re-verify
  //    before presenting. A record that cannot prove provenance, or fails
  //    re-verification, is quarantined, not shown. Acked history never reaches
  //    this branch.
  for (const f of listMessageFiles(inbox.cur)) {
    const full = join(inbox.cur, f);
    const msg = readMessageFile(full);
    if (msg.read || msg.nackedAt) continue;
    if (msg.retryAfter && Date.parse(msg.retryAfter) > nowMs) continue;
    if (msg.checkedOutBy && !isLeaseExpired(msg, nowMs)) continue;
    let recovered: PromoteResult;
    try {
      recovered = await recoverPromoted(agent, full);
    } catch {
      // Flair unreachable — leave the record in cur/ and retry on a later check.
      continue;
    }
    if (!recovered.ok) continue; // quarantined
    const present: MailMessage = { ...recovered.message, checkedOutAt: nowIso, checkedOutBy };
    writeMessageFile(full, present);
    messages.push(present);
  }

  // Best-effort GC: purge acked/expired messages older than 24h on every check
  try { gcMessages(agent); } catch { /* never block delivery */ }

  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function listMessages(agent: string): MailMessage[] {
  assertValidAgentId(agent);
  const inbox = getInbox(agent);
  const unread = readMessagesFromDir(inbox.fresh, false, "new");
  const cur = readMessagesFromDir(inbox.cur, true, "cur");
  const dlq = readMessagesFromDir(inbox.dlq, true, "dlq");
  // Only a record that proves it came through promotion is presentable from
  // cur/. A forged cur/ record (no envelopeId) is treated like new/ and dlq/:
  // its body is withheld.
  for (const m of cur) {
    if (typeof m.envelopeId !== "string" || m.envelopeId === "") m.body = "";
  }
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
