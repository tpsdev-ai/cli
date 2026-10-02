/**
 * Shared mailbox policy and consumed-id replay store for both first-delivery
 * paths: the CLI's `promote()` and this package's `MailClient`.
 */
import { appendFileSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * Try to parse a message body as a TPS v1 signed envelope.
 *
 * Returns the envelope object, or the string "json-parse-error" (not JSON) or
 * "missing-fields" (JSON but not a v1 envelope).
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

/** Parse a record body as a v1 signed envelope with a string body, or say why it is not one. */
export function parseSignedEnvelope(body: string): { ok: true; envelope: Envelope } | { ok: false; class: "invalid"; reason: string } {
  const parsed = tryParseEnvelope(body);
  if (parsed === "json-parse-error") {
    return { ok: false, class: "invalid", reason: "body is not JSON (signed envelope required)" };
  }
  if (parsed === "missing-fields") {
    return { ok: false, class: "invalid", reason: "body is not a v1 signed envelope" };
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
    // 1a. Topology, not forgery. `verifyEnvelope` resolves every agent-kind
    //     chain entry PLUS `envelope.from`; an unresolvable principal is a
    //     presence failure (Flair is UP — an outage throws above and becomes the
    //     retryable `verify-unavailable`), which on a spoke is the normal shape
    //     of any cross-office envelope. Classify it as its own TERMINAL class so
    //     `invalid` once again means a resolvable principal whose signature is
    //     bad — a trustworthy forgery signal — instead of firing on every
    //     legitimate hub-origin message.
    const missing = UNRESOLVABLE_PRINCIPAL_REASON_RE.exec(verified.reason);
    if (missing) {
      const entry = missing[1]!;
      const reason =
        `unresolvable-principal: ${entry} is not registered in the local Flair ` +
        `(agent-kind delegation-chain entry or sender this mailbox cannot resolve). ` +
        `Spoke-topology condition: a spoke holds only its own principal and hub ` +
        `principals are not distributed downward (see cli#383). Not a signature or ` +
        `forgery verdict. Terminal — message DEAD-LETTERED, NOT delivered.`;
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
      reason: `invalid timestamp (must be an ISO-8601 string, got ${shown})`,
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
  appendFileSync(
    consumedLedgerPath(root),
    `${JSON.stringify({ id: messageId, at: new Date().toISOString() })}\n`,
    "utf-8",
  );
}

/**
 * Parse ledger text into the live id set (entries older than `cutoff` are
 * dropped), the lines to keep, and how many lines were dropped. Both ledger
 * readers use it, so they agree on which ids are live.
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
  return { ids, kept, pruned };
}

/**
 * Read the durable ledger, dropping entries older than the retention. Returns
 * the live id set. When pruning actually removed something the ledger is
 * rewritten in place (atomic replace) so the file stays bounded by age.
 *
 * The replace drops any line appended between the read and the rename, so call
 * this only while holding the mailbox lock. A reader that does not hold the
 * lock uses peekConsumedLedger.
 */
function readConsumedLedger(root: string): Set<string> {
  const path = consumedLedgerPath(root);

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissing(err)) return new Set<string>();
    throw unreadableHistory(path, err);
  }

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
 * return, or null when there is no ledger file. Throws when the ledger exists
 * but cannot be read. It never writes, renames or prunes.
 */
function peekConsumedLedger(root: string): Set<string> | null {
  const path = consumedLedgerPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw unreadableHistory(path, err);
  }
  return parseConsumedLedger(raw, Date.now() - CONSUMED_LEDGER_RETENTION_MS).ids;
}

/**
 * Does this maildir record carry the envelope messageId? Counts both the
 * persisted `envelopeId` and, for legacy records, a body that is itself a
 * signed envelope.
 */
function recordCarriesMessageId(msg: { envelopeId?: unknown; body?: unknown }, messageId: string): boolean {
  if (msg.envelopeId === messageId) return true;
  if (typeof msg.body !== "string") return false;
  const parsed = tryParseEnvelope(msg.body);
  if (parsed === "json-parse-error" || parsed === "missing-fields") return false;
  return (parsed as { messageId?: unknown }).messageId === messageId;
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
        if (recordCarriesMessageId(JSON.parse(readFileSync(full, "utf-8")), messageId)) return true;
      } catch {
        // skip corrupt records
      }
    }
  }
  return false;
}

/**
 * The maildir fallback of isConsumedMessageId: a directory or record that does
 * not exist is skipped, a corrupt record is skipped (as
 * isConsumedMessageId skips it), and any other read error throws.
 */
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
      try {
        if (recordCarriesMessageId(JSON.parse(raw), messageId)) return true;
      } catch {
        // corrupt record — skipped, as isConsumedMessageId skips it
      }
    }
  }
  return false;
}

/**
 * Replay lookup for a reader that does not hold the mailbox lock: true when
 * this envelope messageId is in the consumed ledger or, failing that, in the
 * maildir fallback — the history isConsumedMessageId consults. It writes,
 * renames, prunes and creates nothing. A missing ledger file counts as an empty
 * ledger; a ledger or maildir that cannot be read THROWS, and the caller must
 * withhold the record.
 */
export function peekConsumedForMailboxRoot(root: string, messageId: string): boolean {
  if (peekConsumedLedger(root)?.has(messageId)) return true;
  return maildirHistoryHasMessageId(root, messageId);
}
