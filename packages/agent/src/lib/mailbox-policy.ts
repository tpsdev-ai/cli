/**
 * Shared mailbox policy and consumed-id replay store for both first-delivery
 * paths: the CLI's `promote()` and this package's `MailClient`.
 */
import { appendFileSync, type BigIntStats, closeSync, type Dirent, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
const CONSUMED_LEDGER_FILE = "consumed.jsonl";
const CONSUMED_LEDGER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Bounds checked on later deliverNext() calls for unclaimed in_progress work; the deadline precedes re-verification. */
export const MAX_DELIVERY_PRESENTATIONS = 5;
export const DELIVERY_PRESENTATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * cli#617 slice (b): the presenter that holds an `in_progress` intent. `token`
 * is a per-presentation nonce: completion must present it, so a stale or
 * foreign presentation cannot finalize the current one. `pid` and `start` (the
 * process start token mail-lock records for lock owners) say which process
 * holds it. `moduleNonce` identifies the module copy whose token set tracks it;
 * other copies in the same process are treated as live until process exit or lease expiry.
 */
export interface PresentationClaim {
  token: string;
  pid: number;
  start: string | null;
  moduleNonce: string;
}

/** What a placement intent records (cli#617), as the ReplayStore reads it. */
export interface PlacementState {
  messageId: string;
  phase: PlacementPhase;
  presentations?: number;
  firstPresentedAt?: string;
  claim?: PresentationClaim;
}

/** The result of a completion attempt against the intent (cli#617 slice b). */
export type PlacementCompletion = "completed" | "absent" | "stale" | "identity";

/**
 * The replay gate and placement intents for one mailbox. Call while holding
 * that mailbox's lock (acquireMailLock on the same root).
 */
export interface ReplayStore {
  isConsumed(messageId: string, pendingFile?: string): boolean;
  /**
   * Write a `placing` intent. Refuses to replace an intent in any other phase,
   * with one exception (cli#617). A `failed` marker for a different message,
   * whose payload has left cur/, moves to its tombstone when that name is
   * unoccupied, or is the marker's own inode (treated as an interrupted move).
   * An occupied tombstone refuses the placement by name.
   */
  beginPlacement(messageId: string, file: string, sourcePath?: string | number): void;
  ownsPendingPlacement(messageId: string, file: string): boolean;
  /** A live (not `failed`) intent for this messageId names `file`. */
  hasPendingPlacement(messageId: string, file: string): boolean;
  /** The per-file gate: a quarantined or live (not `failed`) intent names `file`. */
  hasPendingFile(file: string): boolean;
  /**
   * The phase of `file`'s placement intent, or null when it has none (cli#617).
   * Throws MalformedPlacementIntentError on a quarantined or malformed intent.
   */
  placementPhase(file: string): PlacementPhase | null;
  /** Delete a `placing` intent for this messageId. An intent in any other phase is kept. */
  finishPlacement(messageId: string, file: string): void;
  /**
   * Record a consumed messageId. Call ONLY after the record is in cur/; THROWS
   * on failure, and the caller must then roll the move back.
   */
  recordConsumed(messageId: string): void;
  /**
   * cli#617 slice (b): what `file`'s intent records, or null when it has none.
   * Throws MalformedPlacementIntentError on a quarantined or malformed intent.
   */
  placementState(file: string): PlacementState | null;
  /**
   * cli#617 slice (b): advance a live (`placing` or `in_progress`) intent for
   * this message to its next presentation, recording `claim` as its holder. A
   * `placing` intent becomes `in_progress` at presentation 1; an `in_progress`
   * intent's count increments. Returns `absent` when no live intent for this
   * message is present (missing, another message, or a `failed`/`unknown`
   * phase), `presented` with the new count, or terminal `failed` before a sixth
   * presentation or when the deadline is exceeded. The count check permits the fifth.
   * The caller must not present a failed intent and first checks claim liveness.
   * Call under the mailbox lock.
   */
  advancePresentation(messageId: string, file: string, nowIso: string, claim: PresentationClaim): PresentationAdvance;
  /**
   * cli#617 slice (b): the deadline alone. An `in_progress` intent for this
   * message whose first presentation is more than DELIVERY_PRESENTATION_TTL_MS
   * before `nowIso` goes terminal `failed` (`failed`); otherwise it is unchanged
   * (`live`), or there is no `in_progress` intent for this message (`absent`).
   * It never presents. The caller first checks claim liveness. Call under the mailbox lock.
   */
  expireOverdue(messageId: string, file: string, nowIso: string): { status: "failed"; presentations: number } | { status: "live" } | { status: "absent" };
  /**
   * cli#617 slice (b): completion-only finalize, bound to one presentation.
   * Deletes the intent only when it is `in_progress` for this message, its
   * claim carries `token`, and `cur/<file>` is still the file the intent
   * recorded (device, inode, nanosecond ctime and size). Otherwise nothing changes: `absent` (no intent
   * for this message), `stale` (another phase or another presentation's claim),
   * or `identity` (recorded cur/ identity absent or mismatched).
   */
  completePlacement(messageId: string, file: string, token: string): PlacementCompletion;
}

/** The result of advancing a placement intent to its next presentation (cli#617 slice b). */
export type PresentationAdvance =
  | { status: "absent" }
  | { status: "presented"; presentations: number }
  | { status: "failed"; presentations: number };

/** The durable ReplayStore for the mailbox rooted at `root` (`<mailDir>/<agent>`). */
export function mailboxReplayStore(root: string): ReplayStore {
  return {
    isConsumed: (messageId, pendingFile) => isConsumedMessageId(root, messageId, pendingFile),
    beginPlacement: (messageId, file, sourcePath) => writePlacementIntent(root, messageId, file, sourcePath),
    ownsPendingPlacement: (messageId, file) => {
      const intent = readPlacementIntent(root, file);
      if (intent?.messageId !== messageId || !intent.identity) return false;
      try {
        const stat = lstatSync(join(root, "cur", file), { bigint: true });
        return matchesFileIdentity(stat, intent.identity);
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    hasPendingFile: (file) => existsSync(`${placementIntentPath(root, file)}.quarantined`) || isLivePlacement(readPlacementIntent(root, file)),
    hasPendingPlacement: (messageId, file) => {
      const intent = readPlacementIntent(root, file);
      return intent?.messageId === messageId && isLivePlacement(intent);
    },
    placementPhase: (file) => readPlacementIntent(root, file)?.phase ?? null,
    finishPlacement: (messageId, file) => {
      const intent = readPlacementIntent(root, file);
      if (intent?.messageId !== messageId || intent.phase !== "placing") return;
      unlinkSync(placementIntentPath(root, file));
      syncDirectory(root);
    },
    recordConsumed: (messageId) => recordConsumedMessageId(root, messageId),
    placementState: (file) => {
      const intent = readPlacementIntent(root, file);
      if (!intent) return null;
      return {
        messageId: intent.messageId, phase: intent.phase,
        ...(intent.presentations === undefined ? {} : { presentations: intent.presentations }),
        ...(intent.firstPresentedAt === undefined ? {} : { firstPresentedAt: intent.firstPresentedAt }),
        ...(intent.claim === undefined ? {} : { claim: { ...intent.claim } }),
      };
    },
    advancePresentation: (messageId, file, nowIso, claim) => advancePlacementPresentation(root, messageId, file, nowIso, claim),
    expireOverdue: (messageId, file, nowIso) => expireOverduePlacement(root, messageId, file, nowIso),
    completePlacement: (messageId, file, token) => completeInProgressPlacement(root, messageId, file, token),
  };
}

/**
 * List well-formed pending intents with their phase; quarantine malformed ones
 * and omit them. An intent whose phase resolves to `failed` is not pending and
 * is omitted.
 * Call under the mailbox lock and re-read each intent before acting on it.
 */
export function pendingPlacementEntries(root: string): Array<{ messageId: string; file: string; phase: PlacementPhase }> {
  const entries: Array<{ messageId: string; file: string; phase: PlacementPhase }> = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if (isMissing(err)) return entries;
    throw err;
  }
  for (const name of names) {
    if (!/^\.placement-[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(root, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (isMissing(err)) continue; // removed after the listing
      throw err;
    }
    const intent = parsePlacement(raw, path);
    if (!intent) {
      quarantinePlacement(path);
      continue;
    }
    if (!isLivePlacement(intent)) continue;
    entries.push({ messageId: intent.messageId, file: intent.file, phase: intent.phase });
  }
  return entries;
}

function placementIntentPath(root: string, file: string): string {
  return join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);
}

function malformedPlacement(path: string): Error {
  const err = new Error(`malformed placement intent at ${path}`);
  err.name = "MalformedPlacementIntentError";
  return err;
}

function quarantinePlacement(path: string): void {
  const err = malformedPlacement(path);
  writeFileSync(`${path}.quarantined.reason`, `${err.name}: ${err.message}\n`, { mode: 0o600 });
  renameSync(path, `${path}.quarantined`);
  syncDirectory(join(path, ".."));
  console.warn(`${err.name}: ${err.message}`);
}

/**
 * The phase phaseOf RESOLVES for a placement intent (cli#617 design rev 2).
 * Every rule keys on this resolved result, not on the raw `phase` field.
 * phaseOf checks `version`, `presentations` and `firstPresentedAt` before
 * `phase`. An unsupported value in any of them resolves to `unknown` whatever
 * `phase` says: `version: 2` with no `phase`, and `version: 2` with
 * `phase: "failed"`, both resolve to `unknown`. The result reflects what the
 * intent declares; it does not prove the state behind it.
 *
 * - `placing`: a commit in flight. An intent resolves to `placing` when it has
 *   no `phase` (or `phase: "placing"`), a recognized `version` (absent or 1) and
 *   valid liveness values (absent or well-formed). So an otherwise-valid intent
 *   written before phases existed, whose `file` is a plain basename, reads as
 *   before. The one exception: an older intent whose `file` is not a plain
 *   basename, which the old parser accepted when its hashed name matched, is
 *   now malformed and quarantined.
 * - `in_progress`: `phase: "in_progress"` under the same `version` and liveness
 *   conditions; it declares a committed message whose handler has not completed.
 * - `failed`: `phase: "failed"` under the same conditions; it declares a
 *   terminal message (its liveness bound was reached). It is not pending: it
 *   never closes the per-file (filename) gate and is never listed for
 *   recovery, while its message ID stays refused by the consumed-ID (replay)
 *   gate. A different message may need the same basename once the old payload
 *   has left cur/. If the tombstone name (failedTombstonePath) is unoccupied,
 *   or is the marker's own inode (treated as an interrupted move), the marker
 *   moves there and the new placement proceeds. An occupied tombstone refuses
 *   the placement by name. While the payload is in cur/, the marker stays and
 *   the new placement is refused. The record is kept until an operator
 *   removes it.
 * - `unknown`: an unsupported value in a recognized field (`phase`, `version`,
 *   `presentations`, `firstPresentedAt` or `claim`, where `presentations` must
 *   be a non-negative safe integer and a `claim` is valid only on an
 *   `in_progress` intent); other extra fields are ignored. The store never
 *   finishes or replaces it; MailClient recovery, the CLI lease sweep and CLI
 *   promotion never present it; and it is not quarantined solely for that
 *   value. It keeps its own per-file gate closed.
 *
 * Slice (b) adds the writers: MailClient.deliverNext() writes `in_progress`
 * (with its presentation claim) and the liveness bound writes `failed`. Nothing
 * in the agent runtime calls deliverNext() until slice (c).
 */
export type PlacementPhase = "placing" | "in_progress" | "failed" | "unknown";

/** The placement intent schema version this reader understands; an intent without one is this version. */
const PLACEMENT_INTENT_VERSION = 1;

export interface FileIdentity {
  dev: string;
  ino: string;
  ctimeNs?: string;
  size?: string;
}

export function fileIdentity(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), ctimeNs: stat.ctimeNs.toString(), size: stat.size.toString() };
}

export function matchesFileIdentity(stat: BigIntStats, identity: FileIdentity): boolean {
  const current = fileIdentity(stat);
  return stat.isFile() && current.dev === identity.dev && current.ino === identity.ino
    && current.ctimeNs === identity.ctimeNs && current.size === identity.size;
}

interface PlacementIntent {
  messageId: string;
  file: string;
  identity?: FileIdentity;
  phase: PlacementPhase;
  /** Hand-overs so far (rev 2 liveness bound). */
  presentations?: number;
  /** When the first hand-over happened (rev 2 liveness bound). */
  firstPresentedAt?: string;
  /** The presentation holding an `in_progress` intent (slice b). */
  claim?: PresentationClaim;
}

/** A plain basename: non-empty, not `.` or `..`, with no path separator or NUL. */
function isPlainBasename(file: string): boolean {
  return file !== "" && file !== "." && file !== ".." && !/[/\\\0]/.test(file);
}

const CLAIM_TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A presentation claim has UUID token/module nonces, a positive pid and a start token string or null. */
function isPresentationClaim(value: unknown): value is PresentationClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.token === "string" && CLAIM_TOKEN_SHAPE.test(claim.token)
    && typeof claim.moduleNonce === "string" && CLAIM_TOKEN_SHAPE.test(claim.moduleNonce)
    && Number.isSafeInteger(claim.pid) && (claim.pid as number) > 0
    && (claim.start === null || (typeof claim.start === "string" && claim.start.length > 0 && claim.start.length <= 256));
}

/**
 * Resolve the phase of a parsed intent. `version`, `presentations` and
 * `firstPresentedAt` are checked first, and an unsupported value in any of them
 * resolves to `unknown` whatever `phase` says. Then `phase` resolves: absent or
 * `placing`, `in_progress`, `failed`, and anything else is `unknown`. `unknown`
 * is not malformed, and other extra fields are ignored. A malformed identity or
 * basename is still malformed (parsePlacement).
 */
function phaseOf(intent: Record<string, unknown>): PlacementPhase {
  if (intent.version !== undefined && intent.version !== PLACEMENT_INTENT_VERSION) return "unknown";
  const presentations = intent.presentations;
  if (presentations !== undefined && !(Number.isSafeInteger(presentations) && (presentations as number) >= 0)) return "unknown";
  const firstPresentedAt = intent.firstPresentedAt;
  if (firstPresentedAt !== undefined && (typeof firstPresentedAt !== "string" || Number.isNaN(Date.parse(firstPresentedAt)))) {
    return "unknown";
  }
  const claim = intent.claim;
  if (claim !== undefined && !isPresentationClaim(claim)) return "unknown";
  const phase = intent.phase;
  let resolved: PlacementPhase;
  if (phase === undefined || phase === "placing") resolved = "placing";
  else if (phase === "in_progress" || phase === "failed") resolved = phase;
  else return "unknown";
  // A claim is valid only on an in_progress intent.
  if (claim !== undefined && resolved !== "in_progress") return "unknown";
  return resolved;
}

/** A pending intent: any resolved phase but `failed`. */
function isLivePlacement(intent: PlacementIntent | null): boolean {
  return intent !== null && intent.phase !== "failed";
}

/**
 * Parse an intent, or null when it is malformed: the name, messageId and
 * identity must hold. An unsupported value in `phase`, `version` or a liveness
 * field alone never makes an intent malformed (see phaseOf).
 */
function parsePlacement(raw: string, path: string): PlacementIntent | null {
  try {
    const intent = JSON.parse(raw);
    if (typeof intent?.file === "string" && isPlainBasename(intent.file)
      && placementIntentPath(join(path, ".."), intent.file) === path
      && isValidEnvelopeId(intent?.messageId)
      && (intent.identity === undefined || (typeof intent.identity?.dev === "string"
        && typeof intent.identity?.ino === "string" && /^(0|[1-9][0-9]*)$/.test(intent.identity.dev)
        && /^[1-9][0-9]*$/.test(intent.identity.ino)
        && (intent.identity.ctimeNs === undefined || (typeof intent.identity.ctimeNs === "string" && /^-?(0|[1-9][0-9]*)$/.test(intent.identity.ctimeNs)))
        && (intent.identity.size === undefined || (typeof intent.identity.size === "string" && /^(0|[1-9][0-9]*)$/.test(intent.identity.size)))))) {
      const phase = phaseOf(intent);
      return {
        messageId: intent.messageId, file: intent.file, identity: intent.identity, phase,
        ...(phase === "unknown" ? {} : {
          presentations: intent.presentations,
          firstPresentedAt: intent.firstPresentedAt,
          ...(intent.claim === undefined ? {} : { claim: { token: intent.claim.token, pid: intent.claim.pid, start: intent.claim.start, moduleNonce: intent.claim.moduleNonce } }),
        }),
      };
    }
  } catch {}
  return null;
}

function readPlacementIntent(root: string, file: string): PlacementIntent | null {
  const path = placementIntentPath(root, file);
  if (existsSync(`${path}.quarantined`)) throw malformedPlacement(path);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const intent = parsePlacement(raw, path);
  if (!intent) {
    quarantinePlacement(path);
    throw malformedPlacement(path);
  }
  return intent;
}

/**
 * Where a retired `failed` marker for `file` is kept (cli#617):
 * `.placement-<sha256(file)>.failed-<messageId>.json`. A tombstone leaves the
 * per-file (filename) gate open and is never listed for recovery. It keeps its
 * message ID retained in the consumed ledger (pendingPlacementIds), so the
 * consumed-ID (replay) gate still refuses that message. It stays until an
 * operator removes it.
 */
function failedTombstonePath(root: string, file: string, messageId: string): string {
  return `${placementIntentPath(root, file).slice(0, -".json".length)}.failed-${messageId}.json`;
}

const FAILED_TOMBSTONE_NAME = /^\.placement-[a-f0-9]{64}\.failed-(.+)\.json$/;

/**
 * Move a `failed` marker to its tombstone without ever replacing one: the link
 * fails if the tombstone name is taken. A tombstone that is the marker's own
 * inode is treated as an interrupted earlier move, which this finishes. Any
 * other occupant is refused by name, and the marker and the tombstone are both
 * kept.
 */
function retireFailedMarker(root: string, path: string, file: string, messageId: string): void {
  const tombstone = failedTombstonePath(root, file, messageId);
  try {
    linkSync(path, tombstone);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const marker = lstatSync(path, { bigint: true });
    const kept = lstatSync(tombstone, { bigint: true });
    if (!matchesFileIdentity(marker, fileIdentity(kept))) {
      const refusal = new Error(`failed tombstone occupied for ${file} (message ${messageId}); marker and tombstone kept`);
      refusal.name = "FailedTombstoneOccupiedError";
      throw refusal;
    }
  }
  unlinkSync(path);
  syncDirectory(root);
}

function isAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    if (isMissing(err)) return true;
    throw err;
  }
}

function syncDirectory(root: string): void {
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writePlacementIntent(root: string, messageId: string, file: string, sourcePath?: string | number): void {
  if (!isValidEnvelopeId(messageId)) throw new Error("invalid placement messageId");
  if (!isPlainBasename(file)) throw new Error("placement file is not a plain basename");
  const path = placementIntentPath(root, file);
  const existing = readPlacementIntent(root, file);
  if (existing && existing.messageId !== messageId) {
    // cli#617: once its payload has left cur/, a `failed` marker yields its
    // basename to a different message. It moves to its tombstone, keeping the
    // operator's record and the old consumed ID, and this placement proceeds.
    // The exception is an occupied tombstone, which refuses by name
    // (retireFailedMarker).
    if (existing.phase !== "failed" || !isAbsent(join(root, "cur", file))) {
      throw new Error(`placement intent for ${file} names another message`);
    }
    retireFailedMarker(root, path, file, existing.messageId);
  } else if (existing && existing.phase !== "placing") {
    // cli#617: only a `placing` intent is rewritten; any other phase is kept.
    throw new Error(`placement intent for ${file} is ${existing.phase}; not replaced`);
  }
  let identity: PlacementIntent["identity"];
  if (sourcePath !== undefined) {
    const stat = typeof sourcePath === "number" ? fstatSync(sourcePath, { bigint: true }) : lstatSync(sourcePath, { bigint: true });
    if (!stat.isFile()) throw new Error("placement source is not a regular file");
    identity = fileIdentity(stat);
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify({ messageId, file, identity }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDirectory(root);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * cli#617 slice (b): rewrite the live intent for `file` in place, keeping its
 * messageId and recorded identity. Refuses (returns false) unless a `placing`
 * or `in_progress` intent for this message is present; a `failed` or `unknown`
 * intent, or another message's intent, is never replaced. The write is the
 * temp-file, fsync, rename, directory-fsync sequence. A
 * `.phase.tmp` suffix marks the phase transition for the crash-boundary
 * fixture (mail-kill-child).
 */
function writePlacementPhase(root: string, messageId: string, file: string, fields: Record<string, unknown>): boolean {
  const path = placementIntentPath(root, file);
  const existing = readPlacementIntent(root, file);
  if (!existing || existing.messageId !== messageId) return false;
  if (existing.phase !== "placing" && existing.phase !== "in_progress") return false;
  const next: Record<string, unknown> = {
    messageId,
    file,
    ...(existing.identity ? { identity: existing.identity } : {}),
    ...fields,
  };
  const tmp = `${path}.${randomUUID()}.phase.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDirectory(root);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

/** Is an `in_progress` intent past the deadline at `nowIso`? An intent without a first presentation never is. */
function pastDeliveryDeadline(intent: PlacementIntent, nowIso: string): boolean {
  if (intent.firstPresentedAt === undefined) return false;
  return Date.parse(nowIso) - Date.parse(intent.firstPresentedAt) > DELIVERY_PRESENTATION_TTL_MS;
}

/** Write the terminal `failed` phase over a live intent, dropping its claim. */
function failPlacement(root: string, messageId: string, file: string, presentations: number, firstPresentedAt: string): boolean {
  return writePlacementPhase(root, messageId, file, {
    version: PLACEMENT_INTENT_VERSION, phase: "failed", presentations, firstPresentedAt,
  });
}

/**
 * cli#617 slice (b): advance a live intent to its next presentation, or to the
 * terminal `failed` phase before a sixth presentation or when the deadline is
 * exceeded. The count check permits the fifth. A `placing`
 * intent becomes `in_progress` at presentation 1 (the first hand-over, counted
 * before it); an `in_progress` intent's count increments. Either way the new
 * presentation's claim replaces any earlier one, so an earlier presentation can
 * no longer complete it. `failed` and `unknown` are not live, so they advance
 * to `absent`.
 */
function advancePlacementPresentation(
  root: string, messageId: string, file: string, nowIso: string, claim: PresentationClaim,
): PresentationAdvance {
  if (!isPresentationClaim(claim)) throw new Error("invalid presentation claim");
  const intent = readPlacementIntent(root, file);
  if (!intent || intent.messageId !== messageId) return { status: "absent" };
  if (intent.phase === "placing") {
    const written = writePlacementPhase(root, messageId, file, {
      version: PLACEMENT_INTENT_VERSION, phase: "in_progress", presentations: 1, firstPresentedAt: nowIso, claim,
    });
    return written ? { status: "presented", presentations: 1 } : { status: "absent" };
  }
  if (intent.phase !== "in_progress") return { status: "absent" };
  const previous = intent.presentations ?? 0;
  const firstPresentedAt = intent.firstPresentedAt ?? nowIso;
  const next = previous + 1;
  if (next > MAX_DELIVERY_PRESENTATIONS || pastDeliveryDeadline(intent, nowIso)) {
    return failPlacement(root, messageId, file, previous, firstPresentedAt)
      ? { status: "failed", presentations: previous }
      : { status: "absent" };
  }
  const written = writePlacementPhase(root, messageId, file, {
    version: PLACEMENT_INTENT_VERSION, phase: "in_progress", presentations: next, firstPresentedAt, claim,
  });
  return written ? { status: "presented", presentations: next } : { status: "absent" };
}

/** cli#617 slice (b): the deadline alone, never a presentation (see ReplayStore.expireOverdue). */
function expireOverduePlacement(
  root: string, messageId: string, file: string, nowIso: string,
): { status: "failed"; presentations: number } | { status: "live" } | { status: "absent" } {
  const intent = readPlacementIntent(root, file);
  if (!intent || intent.messageId !== messageId || intent.phase !== "in_progress") return { status: "absent" };
  if (!pastDeliveryDeadline(intent, nowIso)) return { status: "live" };
  const presentations = intent.presentations ?? 0;
  return failPlacement(root, messageId, file, presentations, intent.firstPresentedAt!)
    ? { status: "failed", presentations }
    : { status: "absent" };
}

/**
 * cli#617 slice (b): completion-only finalize, bound to one presentation: the
 * intent must be `in_progress` for this message, carry `token` in its claim,
 * and still name the cur/ file at its recorded identity.
 */
function completeInProgressPlacement(root: string, messageId: string, file: string, token: string): PlacementCompletion {
  const intent = readPlacementIntent(root, file);
  if (!intent || intent.messageId !== messageId) return "absent";
  if (intent.phase !== "in_progress" || intent.claim?.token !== token) return "stale";
  if (!intent.identity) return "identity";
  let stat: BigIntStats;
  try {
    stat = lstatSync(join(root, "cur", file), { bigint: true });
  } catch (err) {
    if (isMissing(err)) return "identity";
    throw err;
  }
  if (!matchesFileIdentity(stat, intent.identity)) return "identity";
  unlinkSync(placementIntentPath(root, file));
  syncDirectory(root);
  return "completed";
}

function pendingPlacementIds(root: string, quarantine = false): { ids: Set<string>; blocked: Set<string>; retainAll: boolean } {
  const ids = new Set<string>();
  const blocked = new Set<string>();
  let retainAll = false;
  for (const name of readdirSync(root)) {
    // A retired `failed` marker keeps its message ID retained, by its name alone.
    const tombstone = FAILED_TOMBSTONE_NAME.exec(name);
    if (tombstone) {
      if (isValidEnvelopeId(tombstone[1])) ids.add(tombstone[1]);
      continue;
    }
    if (!/^\.placement-[a-f0-9]{64}\.json(?:\.quarantined)?$/.test(name)) continue;
    const path = join(root, name.replace(/\.quarantined$/, ""));
    const raw = readFileSync(join(root, name), "utf8");
    const intent = name.endsWith(".quarantined") ? null : parsePlacement(raw, path);
    if (intent) {
      ids.add(intent.messageId);
      continue;
    }
    const matches = [...raw.matchAll(/"messageId"\s*:\s*("(?:[^"\\]|\\.)*")/g)];
    if (matches.length === 0 || matches.length !== [...raw.matchAll(/"messageId"\s*:/g)].length) retainAll = true;
    for (const match of matches) {
      try {
        const id = JSON.parse(match[1]!);
        if (isValidEnvelopeId(id)) { ids.add(id); blocked.add(id); }
        else retainAll = true;
      } catch { retainAll = true; }
    }
    if (quarantine && !name.endsWith(".quarantined")) quarantinePlacement(path);
  }
  return { ids, blocked, retainAll };
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

function parseConsumedLedger(raw: string, cutoff: number, pendingIds: Set<string>, retainAll = false): { ids: Set<string>; kept: string[]; pruned: number } {
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
    if (at < cutoff && !retainAll && !pendingIds.has(id)) {
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
  const pending = pendingPlacementIds(root, true);
  if (raw === null) return pending.blocked;

  const { ids, kept, pruned } = parseConsumedLedger(raw, Date.now() - CONSUMED_LEDGER_RETENTION_MS, pending.ids, pending.retainAll);
  if (pruned > 0) {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
      renameSync(tmp, path);
    } catch {
      // Pruning is housekeeping — non-fatal, retried on the next read.
    }
  }
  for (const id of pending.blocked) ids.add(id);
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
  const pending = pendingPlacementIds(root);
  return parseConsumedLedger(raw, Date.now() - CONSUMED_LEDGER_RETENTION_MS, pending.ids, pending.retainAll).ids;
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
function isConsumedMessageId(root: string, messageId: string, pendingFile?: string): boolean {
  if (readConsumedLedger(root).has(messageId)) return true;

  return maildirHistoryHasMessageId(root, messageId, pendingFile === undefined ? undefined : join(root, "cur", pendingFile));
}

function maildirHistoryHasMessageId(root: string, messageId: string, pendingPath?: string): boolean {
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
      if (full === pendingPath) continue;
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
