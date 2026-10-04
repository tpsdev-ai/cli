/**
 * Shared mailbox policy and consumed-id replay store for both first-delivery
 * paths: the CLI's `promote()` and this package's `MailClient`.
 */
import { appendFileSync, type Dirent, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Envelope, type FlairClient, verifyEnvelope } from "./signEnvelope.js";

// ─── Envelope id shape (cli#429) ─────────────────────────────────────────────
//
// signOutboundBody validates replyToId before signing. The mailbox policy
// validates messageId and any replyToId on receipt; signEnvelope itself does not.

/** 1-128 chars of `[A-Za-z0-9._-]`. Anchored; no flags. */
export const ENVELOPE_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** A human-readable statement of ENVELOPE_ID_SHAPE, for error messages. */
export const ENVELOPE_ID_SHAPE_TEXT = "letters, digits, dot, underscore or hyphen, 1-128 chars";

/** True only for a string that satisfies ENVELOPE_ID_SHAPE. */
export function isValidEnvelopeId(id: unknown): id is string {
  return typeof id === "string" && ENVELOPE_ID_SHAPE.test(id);
}

/** Describe a rejected id without echoing it: its type, and its length for a string. */
function describeIdValue(value: unknown): string {
  if (typeof value === "string") return value.length === 0 ? "an empty string" : `a ${value.length}-char string outside the rule`;
  return value === null ? "null" : typeof value;
}

// ─── Envelope parsing ────────────────────────────────────────────────────────

/**
 * Try to parse a message body as an envelope-shaped record.
 *
 * Returns the envelope object, or the string "json-parse-error" (not JSON) or
 * "missing-fields" (JSON but not envelope-shaped).
 */
export function tryParseEnvelope(body: string): Record<string, unknown> | "json-parse-error" | "missing-fields" {
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

/** Parse an envelope-shaped record with a string body. */
export function parseSignedEnvelope(body: string): { ok: true; envelope: Envelope } | { ok: false; class: "invalid"; reason: string } {
  const parsed = tryParseEnvelope(body);
  if (parsed === "json-parse-error") {
    return { ok: false, class: "invalid", reason: "body is not JSON (signed envelope required)" };
  }
  if (parsed === "missing-fields") {
    return { ok: false, class: "invalid", reason: "body is not envelope-shaped" };
  }
  if (typeof parsed.body !== "string") {
    return { ok: false, class: "invalid", reason: "envelope body is not a string" };
  }
  if (typeof parsed.from !== "string" || !(parsed.delegationChain as unknown[]).every((hop) => {
    if (!hop || typeof hop !== "object") return false;
    const entry = hop as Record<string, unknown>;
    return typeof entry.agent === "string" && (entry.kind === "agent" || entry.kind === "human")
      && (entry.signature === null || typeof entry.signature === "string");
  })) {
    return { ok: false, class: "invalid", reason: "invalid envelope sender or delegation chain" };
  }
  return { ok: true, envelope: parsed as unknown as Envelope };
}

export function isTopicRecipient(address: unknown, agentId: string, from: string): boolean {
  if (typeof address !== "string" || !address.startsWith("topic:")) return false;
  const topic = address.slice("topic:".length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic) || topic.length > 64) return false;
  try {
    const root = process.env.TPS_HOME || join(process.env.HOME || homedir(), ".tps");
    const meta = JSON.parse(readFileSync(join(root, "topics", topic, "meta.json"), "utf8"));
    return Array.isArray(meta.subscribers) && meta.subscribers.includes(agentId)
      && (meta.allowedPublishers === undefined || (Array.isArray(meta.allowedPublishers)
        && (meta.allowedPublishers.length === 0 || meta.allowedPublishers.includes(from))));
  } catch {
    return false;
  }
}

// ─── The mailbox decision ────────────────────────────────────────────────────

/** The reject classes the mailbox policy and the replay gate emit. */
export type MailboxPolicyRejectClass = "invalid" | "unresolvable-principal" | "wrong-recipient" | "replay";

export type MailboxPolicyResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; class: MailboxPolicyRejectClass; reason: string };

/**
 * The stable reason string `verifyEnvelope` returns when an agent-kind chain
 * entry or `envelope.from` cannot be resolved from the LOCAL Flair. It is a
 * presence failure, not a signature failure: the principal is simply not
 * registered here.
 */
const UNRESOLVABLE_PRINCIPAL_REASON_RE = /^agent (.+) not found in Flair$/;

/**
 * The ONE mailbox decision for an enveloped record.
 *
 * The checks, in order:
 *   1. signature, through the caller's Flair client;
 *   2. wrapper/envelope `from` binding;
 *   3. recipient binding;
 *   4. `messageId` shape, and `replyToId` shape when present;
 *   5. `timestamp` shape.
 *
 * The replay gate (first delivery only) is the ReplayStore below.
 */
export async function decideEnvelopeForMailbox(
  agent: string,
  envelope: Envelope,
  wrapperFrom: unknown,
  client: FlairClient,
): Promise<MailboxPolicyResult> {
  // 1. Signature.
  const verified = await verifyEnvelope(envelope, client);
  if (!verified.ok) {
    // Unresolved-principal presence failure.
    // CLI promotion attempts verify-unavailable dead-lettering on verifier throws;
    // MailClient leaves the record in new/ for retry.
    const missing = UNRESOLVABLE_PRINCIPAL_REASON_RE.exec(verified.reason);
    if (missing) {
      const entry = missing[1]!;
      const reason =
        `unresolvable-principal: ${entry} is not registered in the local Flair ` +
        `(agent-kind delegation-chain entry or sender this mailbox cannot resolve). ` +
        `Possible spoke-topology cause: a spoke holds only its own principal and hub ` +
        `principals are not distributed downward (see cli#383). Not a signature or ` +
        `forgery verdict. Terminal — delivery refused.`;
      return { ok: false, class: "unresolvable-principal", reason };
    }
    return { ok: false, class: "invalid", reason: `signature verification failed: ${verified.reason}` };
  }

  // 2. The wrapper `from` is what consumers route by, and it is unverified; a
  //    wrapper/envelope mismatch is itself a reject.
  if (typeof wrapperFrom !== "string" || wrapperFrom !== envelope.from) {
    return {
      ok: false,
      class: "invalid",
      reason: `wrapper/envelope from mismatch (wrapper.from=${String(wrapperFrom)}, envelope.from=${envelope.from})`,
    };
  }

  if (envelope.to !== agent && !isTopicRecipient(envelope.to, agent, envelope.from)) {
    return {
      ok: false,
      class: "wrong-recipient",
      reason: `wrong-recipient (envelope.to=${envelope.to}, mailbox=${agent})`,
    };
  }

  // 4. `messageId` shape — the replay gate keys on it, a reply threads on it,
  //    and verifyEnvelope does not enforce it. A malformed id is a terminal
  //    reject, not an undefined key that silently never matches. The reason
  //    never echoes the value (it may carry control characters); it names only
  //    the type/length.
  if (!isValidEnvelopeId(envelope.messageId)) {
    return {
      ok: false,
      class: "invalid",
      reason: `invalid messageId (must be ${ENVELOPE_ID_SHAPE_TEXT}; got ${describeIdValue(envelope.messageId)})`,
    };
  }

  // 4b. `replyToId` shape (cli#429): optional, but when the envelope carries
  //    the field it must satisfy the same rule — a signed value outside it is
  //    never presented, whoever signed it.
  if ((envelope as { replyToId?: unknown }).replyToId !== undefined && !isValidEnvelopeId(envelope.replyToId)) {
    return {
      ok: false,
      class: "invalid",
      reason: `invalid replyToId (must be ${ENVELOPE_ID_SHAPE_TEXT}; got ${describeIdValue(envelope.replyToId)})`,
    };
  }

  // 5. `timestamp` shape — a malformed/absent timestamp is rejected, never
  //    silently replaced by the wrapper's unsigned value (that fallback would
  //    let an unsigned field stand in for a signed one).
  if (typeof envelope.timestamp !== "string" || Number.isNaN(Date.parse(envelope.timestamp))) {
    const shown = typeof envelope.timestamp === "string" ? JSON.stringify(envelope.timestamp) : String(envelope.timestamp);
    return {
      ok: false,
      class: "invalid",
      reason: `invalid timestamp (must be a parseable timestamp, got ${shown})`,
    };
  }

  return { ok: true, envelope };
}

// ─── Durable consumed-id ledger (replay gate that survives maildir GC) ───────
//
// The ledger is appended on consumption and pruned by age, independently of
// maildir cleanup.
const CONSUMED_LEDGER_FILE = "consumed.jsonl";
const CONSUMED_LEDGER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The replay gate for one mailbox. Both methods must be called while holding
 * that mailbox's lock (acquireMailLock on the same root).
 */
export interface ReplayStore {
  /** Has this envelope messageId already been consumed? */
  isConsumed(messageId: string): boolean;
  /**
   * Record a consumed messageId. Call ONLY after the record is in cur/; THROWS
   * on failure, and the caller must then roll the move back.
   */
  recordConsumed(messageId: string): void;
}

/** The durable ReplayStore for the mailbox rooted at `root` (`<mailDir>/<agent>`). */
export function mailboxReplayStore(root: string): ReplayStore {
  return {
    isConsumed: (messageId) => isConsumedMessageId(root, messageId),
    recordConsumed: (messageId) => recordConsumedMessageId(root, messageId),
  };
}

function consumedLedgerPath(root: string): string {
  return join(root, CONSUMED_LEDGER_FILE);
}

/**
 * Append after writing cur/. A successful append commits the promotion.
 */
function recordConsumedMessageId(root: string, messageId: string): void {
  mkdirSync(root, { recursive: true });
  const path = consumedLedgerPath(root);
  const raw = readLedgerText(root);
  if (raw === null) writeFileSync(path, "", { flag: "wx" });
  try {
    writeFileSync(join(root, ".consumed-initialized"), "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  appendFileSync(path, `${raw !== null && raw !== "" && !raw.endsWith("\n") ? "\n" : ""}${JSON.stringify({ id: messageId, at: new Date().toISOString() })}\n`, "utf-8");
}

/**
 * Parse ledger text, pruning entries with parseable stored timestamps before `cutoff`.
 * Both ledger readers use it, so they agree on which ids are live.
 */
function parseConsumedLedger(raw: string, cutoff: number): { ids: Set<string>; kept: string[]; pruned: number } {
  const ids = new Set<string>();
  const kept: string[] = [];
  let pruned = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: { id?: unknown; at?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      // Retain intact IDs; a line without one blocks delivery.
      const matches = [...line.matchAll(/"id"\s*:\s*("(?:[^"\\]|\\.)*")/g)];
      if (matches.length === 0 || matches.length !== [...line.matchAll(/"id"\s*:/g)].length) {
        throw new Error("consumed history has an unrecoverable ID");
      }
      for (const match of matches) {
        const id = JSON.parse(match[1]!);
        if (!isValidEnvelopeId(id)) throw new Error("consumed history has an invalid ID");
        ids.add(id);
      }
      kept.push(line);
      continue;
    }
    const id = entry?.id;
    if (!isValidEnvelopeId(id)) throw new Error("consumed history has an invalid ID");
    const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    if (Number.isNaN(at)) {
      ids.add(id);
      kept.push(line);
      continue;
    }
    if (at < cutoff) {
      pruned++;
      continue;
    }
    ids.add(id);
    kept.push(line);
  }
  return { ids, kept, pruned };
}

/**
 * The replace drops any line appended between the read and the rename, so call
 * this only while holding the mailbox lock. A reader that does not hold the
 * lock uses peekConsumedLedger.
 */
function readConsumedLedger(root: string): Set<string> {
  const path = consumedLedgerPath(root);

  const raw = readLedgerText(root);
  if (raw === null) return new Set<string>();

  const { ids, kept, pruned } = parseConsumedLedger(raw, Date.now() - CONSUMED_LEDGER_RETENTION_MS);
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

/** A read error on consumed history, naming the path that could not be read. */
function unreadableHistory(path: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (err instanceof Error ? err.message : String(err));
  return new Error(`consumed history at ${path} is unreadable (${detail})`);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Read the ledger without changing it: the live id set readConsumedLedger would
 * return, or null for an uninitialized missing ledger. It never writes,
 * renames or prunes.
 */
function peekConsumedLedger(root: string): Set<string> | null {
  const raw = readLedgerText(root);
  if (raw === null) return null;
  return parseConsumedLedger(raw, Date.now() - CONSUMED_LEDGER_RETENTION_MS).ids;
}

/**
 * Does this maildir record carry the envelope messageId? Counts both the
 * persisted `envelopeId` and, for legacy records, a body that is itself a
 * signed envelope.
 */
function recordCarriesMessageId(msg: { envelopeId?: unknown; body?: unknown }, messageId: string): boolean {
  if (msg.envelopeId !== undefined) {
    if (!isValidEnvelopeId(msg.envelopeId)) throw new Error("consumed record has an invalid envelope ID");
    return msg.envelopeId === messageId;
  }
  if (typeof msg.body !== "string") throw new Error("consumed record has no envelope ID");
  const parsed = tryParseEnvelope(msg.body);
  if (parsed === "json-parse-error" || parsed === "missing-fields" || !isValidEnvelopeId(parsed.messageId)) {
    throw new Error("consumed record has no recoverable envelope ID");
  }
  return parsed.messageId === messageId;
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
 *
 * It reads the ledger through readConsumedLedger, which may rewrite the ledger:
 * call it only while holding the mailbox lock.
 */
function isConsumedMessageId(root: string, messageId: string): boolean {
  if (readConsumedLedger(root).has(messageId)) return true;

  return maildirHistoryHasMessageId(root, messageId);
}

function maildirHistoryHasMessageId(root: string, messageId: string): boolean {
  const stack = [join(root, "cur"), join(root, "archive")];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) continue;
      throw unreadableHistory(dir, err);
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf-8");
      } catch (err) {
        if (isMissing(err)) continue; // removed after the listing
        throw unreadableHistory(full, err);
      }
      let record;
      try { record = JSON.parse(raw); } catch { throw new Error(`consumed history at ${full} is corrupt`); }
      if (record == null || typeof record !== "object") throw new Error(`consumed history at ${full} is corrupt`);
      if (recordCarriesMessageId(record, messageId)) return true;
    }
  }
  return false;
}

/**
 * Replay lookup for a reader that does not hold the mailbox lock: true when
 * this envelope messageId is in the consumed ledger or, failing that, in the
 * maildir fallback — the history isConsumedMessageId consults. It writes,
 * renames, prunes and creates nothing. Unavailable history throws; the caller
 * must withhold the record.
 */
export function peekConsumedForMailboxRoot(root: string, messageId: string): boolean {
  if (peekConsumedLedger(root)?.has(messageId)) return true;
  return maildirHistoryHasMessageId(root, messageId);
}

function readLedgerText(root: string): string | null {
  const path = consumedLedgerPath(root);
  try { return readFileSync(path, "utf-8"); } catch (err) {
    if (!isMissing(err)) throw unreadableHistory(path, err);
    try { readFileSync(join(root, ".consumed-initialized")); } catch (markerErr) {
      if (isMissing(markerErr)) return null;
      throw unreadableHistory(path, markerErr);
    }
    throw new Error(`consumed history at ${path} is missing after initialization`);
  }
}

export function hasCommittedMessageId(root: string, messageId: string): boolean {
  const ids = peekConsumedLedger(root);
  if (ids === null) return false;
  return ids.has(messageId);
}

// ─── First delivery into cur/ (cli#482) ──────────────────────────────────────
//
/** The result of a first-delivery placement. */
export type FirstDelivery = { status: "placed" } | { status: "exists" };

export function placeCurRecord(sourcePath: string, curPath: string): FirstDelivery {
  try {
    linkSync(sourcePath, curPath);
    return { status: "placed" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { status: "exists" };
  }
}
