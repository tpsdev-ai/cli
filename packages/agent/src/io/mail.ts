import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { signEnvelope, type ChainEntry, type Envelope, type FlairClient } from "../lib/signEnvelope.js";
import { PublicKeyFormatError } from "../lib/public-key.js";
import { agentKeyCandidates, readAgentPrivateKey } from "../lib/agent-keys.js";
import { tryAcquireRelayMoveLock } from "../lib/relay-lock.js";
import { mailboxLockRoot } from "../lib/mail-lock-namespace.js";
import { acquireMailLock, type MailLock, processIsGone, processStartToken } from "../lib/mail-lock.js";
import {
  DELIVERY_PRESENTATION_TTL_MS,
  decideEnvelopeForMailbox,
  type MailboxPolicyRejectClass,
  mailboxReplayStore,
  parseSignedEnvelope,
  pendingPlacementEntries,
  type PlacementPhase,
  placeCurRecord,
  type PresentationClaim,
} from "../lib/mailbox-policy.js";
import { verifiedMailTier } from "../lib/bridge-identity.js";

export interface MailMessage {
  filename: string;
  body: string;
  receivedAt: Date;
  /** Untrusted transport metadata. Never grants authority. */
  headers: Record<string, string>;
  /** Sender from the verified envelope when received through MailClient. */
  from: string;
  /** Present only after signature and mailbox policy both passed. */
  verifiedEnvelope?: Envelope;
  trustTier?: "user" | "internal" | "external";
}

/**
 * The mailbox reject classes this path can emit. It uses the SHARED class NAMES
 * (`invalid`, `unresolvable-principal`, `wrong-recipient`) so a dlq sidecar it
 * writes is readable by the shared tooling. It is NOT the full shared class set:
 * this path emits only TERMINAL classes — an outage is refused, not
 * dead-lettered (the record stays in `new/`), so no retryable class is written
 * here.
 */
type MailboxRejectClass = MailboxPolicyRejectClass;

/** A handoff token issued by deliverNext(); pass it to completeDelivery() or releaseDelivery(). */
export interface MailDelivery {
  readonly message: MailMessage;
  /** `<mailbox>/<messageId>`: the same on every presentation of one message, for idempotent handlers. */
  readonly deliveryKey: string;
  /** This hand-over's presentation number; 1 for the first. */
  readonly presentation: number;
}

/**
 * Why deliverNext() handed nothing over although work may be waiting:
 * - `lock-busy`: the mailbox lock was unavailable.
 * - `active`: a live presentation holds the in-flight message (a handler in
 *   this process that has not completed or released it, or another live
 *   process). It is not counted as a presentation.
 * - `cli-record`: a `placing` intent names a CLI-promoted cur/ record (a
 *   plaintext body with the signed envelope stored beside it). MailClient does
 *   not present that format; a CLI mail check finishes that placement.
 * - `verification-failed` / `verification-unavailable`: the pending cur/ copy
 *   did not re-verify, or the verifier (or the trust-tier read) did not answer.
 * - `record-changed`: the pending cur/ copy is missing, is not the file the
 *   intent recorded, or changed during re-verification.
 * - `storage-error`: the placement history or new/ could not be read.
 * - `new-mail-deferred`: a new/ commit was deferred, including when a
 *   placement appeared before its commit lock.
 */
export type DeliveryDeferral =
  | "lock-busy"
  | "active"
  | "cli-record"
  | "verification-failed"
  | "verification-unavailable"
  | "record-changed"
  | "storage-error"
  | "new-mail-deferred";

/** What MailClient.deliverNext() returns (cli#617 slice b). */
export type DeliverNextResult =
  | { status: "delivered"; delivery: MailDelivery }
  /** No placing/in_progress work is pending and new/ holds nothing committable. */
  | { status: "idle" }
  /** Work may be waiting; nothing was handed over and no new mail was committed. */
  | { status: "deferred"; reason: DeliveryDeferral; detail: string; file?: string };

/** What MailClient.completeDelivery() returns (cli#617 slice b). */
export type DeliveryCompletion =
  /** This call removed the message's `in_progress` intent. */
  | { status: "completed" }
  /** An earlier call with this delivery removed it. */
  | { status: "already-completed" }
  /** The mailbox lock was unavailable; nothing changed and the intent stays `in_progress`. */
  | { status: "deferred"; reason: "lock-busy"; detail: string }
  /**
   * Not this hand-over's to finalize; nothing changed. `foreign`: not a
   * delivery this MailClient issued. `stale`: the message was presented again
   * since (another claim), finalized, or moved to another phase. `identity`:
   * cur/ no longer holds the file the intent recorded.
   */
  | { status: "refused"; reason: "foreign" | "stale" | "identity"; detail: string };

type DeferredResult = Extract<DeliverNextResult, { status: "deferred" }>;
/** A pending placement this call resolved without presenting (gone, terminal, or another writer's phase). */
type PendingOutcome = DeliverNextResult | { status: "resolved" };
const RESOLVED: PendingOutcome = { status: "resolved" };

function deferred(reason: DeliveryDeferral, detail: string, file?: string): DeferredResult {
  return { status: "deferred", reason, detail, ...(file === undefined ? {} : { file }) };
}

/**
 * cli#617 slice (b): the presentation tokens THIS PROCESS has handed over and
 * not yet completed or released, across every MailClient in it. A claim on disk
 * naming this process is live only while its token is here. A claim naming
 * another process is live unless that process is provably gone (processIsGone,
 * the lock-owner rule). A claim that is not live is an abandoned presentation,
 * which deliverNext() presents again and counts.
 */
const activePresentations = new Set<string>();
let ownStartToken: string | null | undefined;

function ownClaim(token: string): PresentationClaim {
  if (ownStartToken === undefined) ownStartToken = processStartToken(process.pid);
  return { token, pid: process.pid, start: ownStartToken };
}

function claimIsLive(claim: PresentationClaim | undefined): boolean {
  if (!claim) return false;
  const own = ownClaim(claim.token);
  if (claim.pid === own.pid && claim.start === own.start) return activePresentations.has(claim.token);
  return !processIsGone(claim.pid, claim.start);
}

/** A CLI-promoted cur/ record stores the signed envelope as an object beside a plaintext body. */
function isCliPromotedRecord(bytes: Buffer): boolean {
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    return record !== null && typeof record === "object" && record.envelope !== null && typeof record.envelope === "object";
  } catch {
    return false;
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

type VerifyOutcome =
  | { pass: true; envelope: Envelope }
  | { pass: false; class: MailboxRejectClass; reason: string; from?: string };

/**
 * Write the dlq sidecar for a TERMINAL rejection.
 *
 * It mirrors the shared mail convention's FORMAT — file name `<record>.reason`
 * and a first line `class: <class>`, the shape the shared re-drive's
 * `readReasonSidecar` parses — and reuses the shared class NAMES. It does NOT
 * reproduce the shared reject boundary: only the terminal classes above are
 * emitted, and a retryable outcome (Flair unreachable) writes NO sidecar at all
 * (the record is left in `new/`). So it is "format + the terminal class names
 * this path emits", not the full boundary. (This path previously wrote
 * `${file}.reject` with a bare reason, which no shared reader scans.)
 */
function writeRejectSidecar(dlqDir: string, filename: string, cls: MailboxRejectClass, reason: string): void {
  writeFileSync(
    join(dlqDir, `${filename}.reason`),
    `class: ${cls}\nPromote rejected at ${new Date().toISOString()}\nReason: ${reason}\n`,
    "utf-8",
  );
}

function sameFileByDeviceInode(a: string, b: string): boolean {
  const sa = lstatOrAbsent(a);
  const sb = lstatOrAbsent(b);
  return sa !== null && sb !== null && sa.dev === sb.dev && sa.ino === sb.ino;
}

/**
 * cli#617 slice (a): recovery resumes only an intent whose phase resolves to
 * `placing` (phaseOf). One that resolves to any other phase (`in_progress`, or
 * `unknown`: an unsupported value in a recognized field) is never presented or
 * finished. A phase seen in the listing skips the record before its payload
 * is read, and the under-lock recheck catches a phase that changed after the
 * payload was read and verified.
 *
 * This is the BATCH reader (`checkNewMail`), which stays at-most-once until
 * slice (c) wires the per-message delivery API. Slice (b)'s `deliverNext`
 * presents an `in_progress` intent again through its own completion-gated path
 * (`presentPending`), not this one.
 */
function resumableOnRecovery(phase: PlacementPhase | null): boolean {
  return phase === "placing";
}

function lstatOrAbsent(path: string): { dev: number; ino: number } | null {
  try {
    const st = lstatSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Maildir-compatible mail client.
 * Reads from mailDir/inbox/new and moves processed messages to mailDir/inbox/cur.
 * Writes outgoing mail to mailDir/outbox/new.
 */
export class MailClient {
  private readonly mailboxRoot: string;
  private readonly inboxNew: string;
  private readonly inboxCur: string;
  private readonly inboxDlq: string;
  private readonly outboxNew: string;
  private readonly flairClient: FlairClient;
  /** cli#617 slice (b): the deliveries this client issued, keyed by the delivery object itself. */
  private readonly issued = new WeakMap<MailDelivery, {
    token: string;
    messageId: string;
    file: string;
    state: "active" | "released" | "completed";
  }>();

  constructor(
    public readonly mailDir: string,
    private readonly events?: EventLogger,
    private readonly agentId = "unknown",
    flairClient?: FlairClient,
    /** Configured Flair signing key, checked against both standard locations. */
    private readonly signingKeyPath?: string,
  ) {
    // cli#380: construction without a verifier throws.
    if (!flairClient) {
      throw new Error(
        `MailClient requires a Flair verifier for "${agentId}": refusing to construct a mailbox that ` +
          `could promote unverified mail (cli#380).`,
      );
    }
    this.flairClient = flairClient;
    // cli#616: the mailbox lock root starts from the resolved real path of the
    // configured mail directory (see mail-lock-namespace.ts).
    const lockRoot = mailboxLockRoot(mailDir, agentId);
    for (const dir of ["new", "cur", "dlq", "outbox"]) mkdirSync(join(lockRoot, dir), { recursive: true });
    this.mailDir = dirname(lockRoot);
    this.mailboxRoot = realpathSync(lockRoot);
    this.inboxNew = join(this.mailboxRoot, "new");
    this.inboxCur = join(this.mailboxRoot, "cur");
    this.inboxDlq = join(this.mailboxRoot, "dlq");
    this.outboxNew = join(this.mailboxRoot, "outbox");
  }

  async checkNewMail(): Promise<MailMessage[]> {
    const messages: MailMessage[] = [];
    await this.recoverInterruptedPlacements(messages);
    if (!existsSync(this.inboxNew)) return messages;

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));

    for (const file of files) {
      const started = Date.now();
      const srcPath = join(this.inboxNew, file);

      let body: string;
      try {
        body = readFileSync(srcPath, "utf-8");
      } catch (err) {
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: "unknown",
          durationMs: Date.now() - started,
          error: sanitizeError(err),
        });
        continue; // leave in new/ — a later check retries
      }

      // Verify. A THROW is a refusal, not a pass: leave the record in new/ for a
      // later check (a Flair outage self-heals) and never promote it.
      let verifyResult: VerifyOutcome;
      try {
        verifyResult = await this.verifyMailBody(body);
      } catch (err) {
        const detail = sanitizeError(err);
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: "unknown",
          durationMs: Date.now() - started,
          error: detail,
        });
        console.error(`[MailClient] verification could not run for ${file} — NOT promoting: ${detail}`);
        continue; // leave in new/
      }

      if (!verifyResult.pass) {
        this.deadLetter(file, srcPath, verifyResult, started);
        continue;
      }

      let trustTier: MailMessage["trustTier"];
      try {
        trustTier = verifiedMailTier(verifyResult.envelope, this.mailDir);
      } catch (err) {
        const detail = sanitizeError(err);
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: verifyResult.envelope.from,
          durationMs: Date.now() - started,
          error: detail,
        });
        console.error(`[MailClient] trust tier could not be resolved for ${file} — NOT promoting: ${detail}`);
        continue; // leave in new/
      }

      try {
        const committed = await this.commitToCur(file, srcPath, body, verifyResult.envelope);
        // "live-placement" is returned only to the delivery API (a claim was passed).
        if (committed === "already-delivered" || committed === "live-placement") continue;
        if (committed) {
          this.deadLetter(file, srcPath, { ...committed, from: verifyResult.envelope.from }, started);
          continue;
        }
        const from = verifyResult.envelope.from;
        messages.push({
          filename: file, body, receivedAt: new Date(), headers: {}, from,
          verifiedEnvelope: verifyResult.envelope,
          trustTier,
        });
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "ok",
          from,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: "unknown",
          durationMs: Date.now() - started,
          error: sanitizeError(err),
        });
      }
    }

    return messages;
  }

  /**
   * Present verified, unclaimed pending work before committing new mail.
   * Unresolved placing/in_progress work defers new commits. Active claims defer
   * re-presentation; released or abandoned claims may be retried after verification,
   * subject to the presentation bound and mailbox lock. The event loop uses checkNewMail().
   */
  async deliverNext(): Promise<DeliverNextResult> {
    let pending: Array<{ messageId: string; file: string; phase: PlacementPhase }>;
    const listing = await this.lockOrDefer("pending placements not listed");
    if ("status" in listing) return listing;
    try {
      pending = pendingPlacementEntries(this.mailboxRoot);
    } catch (err) {
      this.emitRecoveryError(err);
      return deferred("storage-error", `pending placements unavailable: ${sanitizeError(err)}`);
    } finally {
      listing.release();
    }
    pending.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    let firstDeferral: DeferredResult | null = null;
    for (const { messageId, file, phase } of pending) {
      if (phase === "unknown") continue; // another writer's phase: preserved, never presented (slice a)
      let outcome: PendingOutcome;
      try {
        outcome = await this.presentPending(messageId, file);
      } catch (err) {
        this.emitRecoveryError(err);
        outcome = deferred("storage-error", sanitizeError(err), file);
      }
      if (outcome.status === "delivered") return outcome;
      if (outcome.status === "deferred") firstDeferral ??= outcome;
    }
    if (firstDeferral) return firstDeferral;
    return this.commitNextForDelivery();
  }

  /** Finalize only this client's issued claim, with its recorded cur/ file identity, under the mailbox lock. */
  async completeDelivery(delivery: MailDelivery): Promise<DeliveryCompletion> {
    const issued = this.issued.get(delivery);
    if (!issued) return { status: "refused", reason: "foreign", detail: "not a delivery this MailClient handed over" };
    if (issued.state === "completed") return { status: "already-completed" };
    const lock = await this.lockOrDefer("delivery not finalized (the intent stays in_progress)");
    if ("status" in lock) return { status: "deferred", reason: "lock-busy", detail: lock.detail };
    let result: ReturnType<ReturnType<typeof mailboxReplayStore>["completePlacement"]>;
    try {
      result = mailboxReplayStore(this.mailboxRoot).completePlacement(issued.messageId, issued.file, issued.token);
    } finally {
      lock.release();
    }
    activePresentations.delete(issued.token);
    if (result === "completed") {
      issued.state = "completed";
      return { status: "completed" };
    }
    issued.state = "released";
    if (result === "identity") {
      return { status: "refused", reason: "identity", detail: `cur/${issued.file} is not the file the intent recorded; not finalized` };
    }
    return {
      status: "refused",
      reason: "stale",
      detail: `message ${issued.messageId} is no longer held by this presentation (presented again, finalized or terminal); not finalized`,
    };
  }

  /** Release this process's active claim for retry; completion remains possible until it is presented again. */
  releaseDelivery(delivery: MailDelivery): boolean {
    const issued = this.issued.get(delivery);
    if (!issued || issued.state !== "active") return false;
    issued.state = "released";
    activePresentations.delete(issued.token);
    return true;
  }

  /** Record a hand-over: the token is already live in this process; bind it to the delivery object. */
  private issue(token: string, messageId: string, file: string, presentation: number, message: MailMessage): MailDelivery {
    const delivery: MailDelivery = Object.freeze({ message, deliveryKey: `${this.agentId}/${messageId}`, presentation });
    this.issued.set(delivery, { token, messageId, file, state: "active" });
    return delivery;
  }

  /**
   * Present one pending placement: inspect it under the lock, re-verify its
   * cur/ copy outside the lock, then re-check and advance under the lock.
   */
  private async presentPending(messageId: string, file: string): Promise<PendingOutcome> {
    const inspected = await this.inspectPending(messageId, file);
    if (inspected.status !== "read") return inspected;
    let outcome: VerifyOutcome;
    try {
      outcome = await this.verifyMailBody(inspected.bytes.toString("utf8"));
    } catch (err) {
      return deferred("verification-unavailable", `re-verification could not run: ${sanitizeError(err)}`, file);
    }
    if (!outcome.pass) return deferred("verification-failed", `the cur/ copy did not re-verify (${outcome.class}): ${outcome.reason}`, file);
    if (outcome.envelope.messageId !== messageId) {
      return deferred("verification-failed", "the cur/ copy's envelope names another message than the intent", file);
    }
    let trustTier: MailMessage["trustTier"];
    try {
      trustTier = verifiedMailTier(outcome.envelope, this.mailDir);
    } catch (err) {
      return deferred("verification-unavailable", `trust tier unavailable: ${sanitizeError(err)}`, file);
    }
    return this.presentUnderLock(messageId, file, inspected.bytes, outcome.envelope, trustTier);
  }

  private async inspectPending(messageId: string, file: string): Promise<PendingOutcome | { status: "read"; bytes: Buffer }> {
    const lock = await this.lockOrDefer("pending placement not inspected", file);
    if ("status" in lock) return lock;
    try {
      const replay = mailboxReplayStore(this.mailboxRoot);
      const state = replay.placementState(file);
      if (!state || state.messageId !== messageId || state.phase === "failed" || state.phase === "unknown") return RESOLVED;
      if (state.phase === "in_progress") {
        if (claimIsLive(state.claim)) {
          return deferred("active", `message ${messageId} is held by a live presentation (not completed or released)`, file);
        }
        const expiry = replay.expireOverdue(messageId, file, new Date().toISOString());
        if (expiry.status === "absent") return RESOLVED;
        if (expiry.status === "failed") {
          this.logQuarantine(messageId, expiry.presentations, "deadline");
          return RESOLVED;
        }
      }
      const curPath = join(this.inboxCur, file);
      let bytes: Buffer;
      try {
        bytes = readFileSync(curPath);
      } catch (err) {
        if (!isMissing(err)) throw err;
        if (state.phase === "placing" && lstatOrAbsent(curPath) === null) {
          replay.finishPlacement(messageId, file);
          return RESOLVED;
        }
        return deferred("record-changed", `cur/${file} is missing for a ${state.phase} intent`, file);
      }
      if (state.phase === "placing" && isCliPromotedRecord(bytes)) {
        return deferred(
          "cli-record",
          `cur/${file} is a CLI-promoted record (plaintext body, signed envelope stored beside it); MailClient does not present it, and a CLI mail check finishes its placement`,
          file,
        );
      }
      return { status: "read", bytes };
    } finally {
      lock.release();
    }
  }

  /**
   * Re-read the intent, its claim, the recorded identity and the raw bytes
   * under the lock (all may have changed during re-verification), then advance
   * the presentation with a new claim and hand the message over. A bound hit
   * writes the terminal `failed` phase and logs, and presents nothing.
   */
  private async presentUnderLock(
    messageId: string,
    file: string,
    bytes: Buffer,
    envelope: Envelope,
    trustTier: MailMessage["trustTier"],
  ): Promise<PendingOutcome> {
    const lock = await this.lockOrDefer("pending placement not presented", file);
    if ("status" in lock) return lock;
    try {
      const replay = mailboxReplayStore(this.mailboxRoot);
      const state = replay.placementState(file);
      if (!state || state.messageId !== messageId || state.phase === "failed" || state.phase === "unknown") return RESOLVED;
      if (state.phase === "in_progress" && claimIsLive(state.claim)) {
        return deferred("active", `message ${messageId} is held by a live presentation (not completed or released)`, file);
      }
      if (!replay.ownsPendingPlacement(messageId, file)) {
        return deferred("record-changed", `cur/${file} is not the file the intent recorded`, file);
      }
      let current: Buffer;
      try {
        current = readFileSync(join(this.inboxCur, file));
      } catch (err) {
        if (isMissing(err)) return deferred("record-changed", `cur/${file} disappeared during re-verification`, file);
        throw err;
      }
      if (!current.equals(bytes)) return deferred("record-changed", `cur/${file} changed during re-verification`, file);
      if (!replay.isConsumed(messageId, file)) replay.recordConsumed(messageId);
      const token = randomUUID();
      const advance = replay.advancePresentation(messageId, file, new Date().toISOString(), ownClaim(token));
      if (advance.status === "absent") return RESOLVED;
      if (advance.status === "failed") {
        this.logQuarantine(messageId, advance.presentations, "count");
        return RESOLVED;
      }
      // Live before the lock is released, so no other call in this process can
      // read the new claim as abandoned.
      activePresentations.add(token);
      const message: MailMessage = {
        filename: file,
        body: bytes.toString("utf8"),
        receivedAt: new Date(),
        headers: {},
        from: envelope.from,
        verifiedEnvelope: envelope,
        trustTier,
      };
      return { status: "delivered", delivery: this.issue(token, messageId, file, advance.presentations, message) };
    } finally {
      lock.release();
    }
  }

  /**
   * The bound's log line. It is written after the durable `failed` write, so a
   * kill between the two leaves the `failed` intent (the durable record) and
   * no line.
   */
  private logQuarantine(messageId: string, presentations: number, cause: "count" | "deadline"): void {
    const why = cause === "deadline"
      ? `the deadline (${DELIVERY_PRESENTATION_TTL_MS / 3_600_000} h after the first presentation) passed`
      : "the presentation bound was reached";
    console.warn(
      `[MailClient] placement quarantined for mailbox ${this.agentId}: message ${messageId} not completed ` +
        `after ${presentations} presentation(s); ${why}; payload retained for the operator`,
    );
  }

  /**
   * Commit the next verifiable new/ message to cur/ with a live `in_progress`
   * intent. Under the commit lock it re-checks that no `placing` or
   * `in_progress` placement is pending, so a concurrent call cannot add a
   * second message in flight.
   */
  private async commitNextForDelivery(): Promise<DeliverNextResult> {
    let files: string[];
    try {
      files = existsSync(this.inboxNew)
        ? readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\")).sort()
        : [];
    } catch (err) {
      this.emitRecoveryError(err);
      return deferred("storage-error", `new/ unavailable: ${sanitizeError(err)}`);
    }
    let skipped: { file: string; detail: string } | null = null;
    for (const file of files) {
      const started = Date.now();
      const srcPath = join(this.inboxNew, file);
      let body: string;
      try {
        body = readFileSync(srcPath, "utf-8");
      } catch (err) {
        if (!isMissing(err)) {
          this.emitRecoveryError(err);
          skipped ??= { file, detail: `unreadable: ${sanitizeError(err)}` };
        }
        continue;
      }
      let verifyResult: VerifyOutcome;
      try {
        verifyResult = await this.verifyMailBody(body);
      } catch (err) {
        this.emitRecoveryError(err); // left in new/ for a later call
        skipped ??= { file, detail: `verification could not run: ${sanitizeError(err)}` };
        continue;
      }
      if (!verifyResult.pass) {
        this.deadLetter(file, srcPath, verifyResult, started);
        continue;
      }
      let trustTier: MailMessage["trustTier"];
      try {
        trustTier = verifiedMailTier(verifyResult.envelope, this.mailDir);
      } catch (err) {
        this.emitRecoveryError(err);
        skipped ??= { file, detail: `trust tier unavailable: ${sanitizeError(err)}` };
        continue;
      }
      const token = randomUUID();
      // Live before the commit writes the claim (see presentUnderLock).
      activePresentations.add(token);
      let delivered = false;
      try {
        const committed = await this.commitToCur(file, srcPath, body, verifyResult.envelope, ownClaim(token));
        if (committed === "already-delivered") continue;
        if (committed === "live-placement") {
          return deferred("new-mail-deferred", "a placement became pending before the commit; nothing committed", file);
        }
        if (committed) {
          this.deadLetter(file, srcPath, { ...committed, from: verifyResult.envelope.from }, started);
          continue;
        }
        const from = verifyResult.envelope.from;
        this.events?.emit({
          type: "mail.receive", agent: this.agentId, status: "ok", from, durationMs: Date.now() - started,
        });
        delivered = true;
        const message: MailMessage = {
          filename: file, body, receivedAt: new Date(), headers: {}, from,
          verifiedEnvelope: verifyResult.envelope, trustTier,
        };
        return { status: "delivered", delivery: this.issue(token, verifyResult.envelope.messageId, file, 1, message) };
      } catch (err) {
        this.emitRecoveryError(err);
        skipped ??= { file, detail: `not committed: ${sanitizeError(err)}` };
      } finally {
        if (!delivered) activePresentations.delete(token);
      }
    }
    return skipped ? deferred("new-mail-deferred", `new/${skipped.file} ${skipped.detail}`, skipped.file) : { status: "idle" };
  }

  /** The mailbox lock, or a `lock-busy` deferral (contention, or an acquisition that threw). */
  private async lockOrDefer(what: string, file?: string): Promise<MailLock | DeferredResult> {
    try {
      return (await acquireMailLock(this.mailboxRoot)) ?? deferred("lock-busy", `mailbox lock busy; ${what}`, file);
    } catch (err) {
      return deferred("lock-busy", `mailbox lock unavailable (${sanitizeError(err)}); ${what}`, file);
    }
  }

  private emitRecoveryError(err: unknown): void {
    this.events?.emit({
      type: "mail.receive", agent: this.agentId, status: "error", from: "unknown", durationMs: 0, error: sanitizeError(err),
    });
  }

  /** Commit under the mailbox lock; attempt placement rollback on append failure. */
  private async commitToCur(
    file: string,
    srcPath: string,
    body: string,
    envelope: Envelope,
    /** cli#617 slice (b): the delivery API's presentation claim; absent for the batch checkNewMail() path. */
    claim?: PresentationClaim,
  ): Promise<{ pass: false; class: MailboxRejectClass; reason: string } | "already-delivered" | "live-placement" | null> {
    const lock: MailLock | null = await acquireMailLock(this.mailboxRoot);
    if (!lock) throw new Error("mailbox lock busy; not promoted");
    let relayLock: MailLock | null;
    try { relayLock = tryAcquireRelayMoveLock(JSON.parse(body), this.mailDir); }
    catch (error) { lock.release(); throw error; }
    if (!relayLock) { lock.release(); throw new Error("relay acceptance busy; not promoted"); }
    try {
      if (readFileSync(srcPath, "utf-8") !== body) throw new Error("source changed during promotion; not promoted");
      const replay = mailboxReplayStore(this.mailboxRoot);
      if (replay.hasPendingFile(file)) throw new Error(`pending placement unresolved: ${file}`);
      if (claim && pendingPlacementEntries(this.mailboxRoot).some((e) => e.phase === "placing" || e.phase === "in_progress")) {
        return "live-placement";
      }
      const dstPath = join(this.inboxCur, file);
      if (sameFileByDeviceInode(srcPath, dstPath)) {
        replay.isConsumed(envelope.messageId);
        unlinkSync(srcPath);
        return "already-delivered";
      }
      const consumed = replay.isConsumed(envelope.messageId);
      if (consumed) {
        return { pass: false, class: "replay", reason: `replay (envelope messageId ${envelope.messageId} already consumed)` };
      }
      replay.beginPlacement(envelope.messageId, file, srcPath);
      const placement = placeCurRecord(srcPath, dstPath);
      if (placement.status === "exists") {
        replay.finishPlacement(envelope.messageId, file);
        throw new Error(`destination already exists: ${file}`);
      }
      try {
        unlinkSync(srcPath);
      } catch (err) {
        unlinkSync(dstPath);
        replay.finishPlacement(envelope.messageId, file);
        throw err;
      }
      try {
        replay.recordConsumed(envelope.messageId);
      } catch (err) {
        try {
          renameSync(dstPath, srcPath);
          replay.finishPlacement(envelope.messageId, file);
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr],
            `mail commit failed: ${sanitizeError(err)}; rollback failed: ${sanitizeError(rollbackErr)}`);
        }
        throw err;
      }
      if (claim) {
        const advance = replay.advancePresentation(envelope.messageId, file, new Date().toISOString(), claim);
        if (advance.status !== "presented") throw new Error(`placement not advanced after commit: ${advance.status}`);
      } else {
        replay.finishPlacement(envelope.messageId, file);
      }
      return null;
    } finally {
      relayLock.release();
      lock.release();
    }
  }

  /**
   * Recover verified cur copies matching the intent's recorded identity (cli#600).
   * Verification or lock failure defers recovery. A present mismatched copy,
   * including an older intent without identity, leaves the intent pending and
   * withholds delivery; the new/ scan cannot replace that intent.
   */
  private async recoverInterruptedPlacements(messages: MailMessage[]): Promise<void> {
    let pending: Array<{ messageId: string; file: string; phase: PlacementPhase }>;
    let listing: MailLock | null = null;
    try {
      listing = await acquireMailLock(this.mailboxRoot);
      if (!listing) return; // lock unavailable; defer recovery
      pending = pendingPlacementEntries(this.mailboxRoot);
    } catch (err) {
      this.events?.emit({
        type: "mail.receive",
        agent: this.agentId,
        status: "error",
        from: "unknown",
        durationMs: 0,
        error: sanitizeError(err),
      });
      return; // a later check retries
    } finally {
      listing?.release();
    }

    for (const { messageId, file, phase } of pending) {
      if (!resumableOnRecovery(phase)) continue;
      const curPath = join(this.inboxCur, file);
      try {
        let bytes: Buffer;
        try {
          bytes = readFileSync(curPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          // Observed absent; re-check under the lock before finishing the intent.
          await this.finishUnlinkedPlacement(messageId, file);
          continue;
        }
        const outcome = await this.verifyMailBody(bytes.toString("utf8"));
        if (!outcome.pass) continue; // withhold: the cur copy is not a verified message
        const trustTier = verifiedMailTier(outcome.envelope, this.mailDir);
        const delivered = await this.completeInterruptedPlacement(messageId, file, bytes, outcome.envelope, trustTier);
        if (delivered) messages.push(delivered);
      } catch (err) {
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: "unknown",
          durationMs: 0,
          error: sanitizeError(err),
        });
      }
    }
  }

  /** Finish a still-pending intent only when cur/ is absent under the lock. */
  private async finishUnlinkedPlacement(messageId: string, file: string): Promise<void> {
    const lock = await acquireMailLock(this.mailboxRoot);
    if (!lock) return;
    try {
      const replay = mailboxReplayStore(this.mailboxRoot);
      if (!replay.hasPendingPlacement(messageId, file)) return;
      if (!resumableOnRecovery(replay.placementPhase(file))) return;
      if (lstatOrAbsent(join(this.inboxCur, file)) !== null) return;
      replay.finishPlacement(messageId, file);
    } finally {
      lock.release();
    }
  }

  /**
   * Re-check the intent, recorded identity and raw bytes under the lock.
   */
  private async completeInterruptedPlacement(
    messageId: string,
    file: string,
    bytes: Buffer,
    envelope: Envelope,
    trustTier: MailMessage["trustTier"],
  ): Promise<MailMessage | null> {
    const lock = await acquireMailLock(this.mailboxRoot);
    if (!lock) throw new Error("mailbox lock busy; interrupted placement recovery deferred");
    try {
      const replay = mailboxReplayStore(this.mailboxRoot);
      // Match the intent, recorded device/inode and pre-verification raw bytes.
      if (!replay.hasPendingPlacement(messageId, file)) return null;
      if (!resumableOnRecovery(replay.placementPhase(file))) return null;
      if (envelope.messageId !== messageId) return null;
      if (!replay.ownsPendingPlacement(messageId, file)) return null;
      let current: Buffer;
      try {
        current = readFileSync(join(this.inboxCur, file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      if (!current.equals(bytes)) return null;
      if (!replay.isConsumed(messageId, file)) replay.recordConsumed(messageId);
      replay.finishPlacement(messageId, file);
      return {
        filename: file,
        body: bytes.toString("utf8"),
        receivedAt: new Date(),
        headers: {},
        from: envelope.from,
        verifiedEnvelope: envelope,
        trustTier,
      };
    } finally {
      lock.release();
    }
  }

  /** Attempt the dlq/ move and sidecar write, then emit the rejection. */
  private deadLetter(
    file: string,
    srcPath: string,
    rejected: { class: MailboxRejectClass; reason: string; from?: string },
    started: number,
  ): void {
    const dlqPath = join(this.inboxDlq, file);
    let relayLock: MailLock | null = null;
    try {
      let record: unknown;
      try { record = JSON.parse(readFileSync(srcPath, "utf-8")); } catch {}
      relayLock = tryAcquireRelayMoveLock(record, this.mailDir);
      if (!relayLock) return;
      if (srcPath !== dlqPath) renameSync(srcPath, dlqPath);
      writeRejectSidecar(this.inboxDlq, file, rejected.class, rejected.reason);
    } catch (err) {
      console.error(`[MailClient] failed to dead-letter ${file}: ${sanitizeError(err)}`);
    } finally { relayLock?.release(); }
    this.events?.emit({
      type: "mail.receive",
      agent: this.agentId,
      status: "rejected",
      from: rejected.from ?? "unknown",
      durationMs: Date.now() - started,
      error: rejected.reason,
    });
  }

  /** Write a message to outbox/new for relay delivery. */
  async sendMail(to: string, body: string): Promise<void> {
    const started = Date.now();
    try {
      const { writeFileSync } = await import("node:fs");
      // Sign the body as this agent — the v1 envelope a promote() reader
      // verifies. signMailBody THROWS when no key exists, so an unsigned body
      // is never written.
      const signed = this.signMailBody(to, body);
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      writeFileSync(
        join(this.outboxNew, filename),
        JSON.stringify({ from: this.agentId, to, body: signed, sentAt: new Date().toISOString() }, null, 2),
        "utf-8"
      );
      this.events?.emit({
        type: "mail.send",
        agent: this.agentId,
        to,
        status: "ok",
        durationMs: Date.now() - started,
      });
    } catch (err) {
      this.events?.emit({
        type: "mail.send",
        agent: this.agentId,
        to,
        status: "error",
        durationMs: Date.now() - started,
        error: sanitizeError(err),
      });
      throw err;
    }
  }

  /**
   * Sign `body` as this agent into a v1 signed envelope. Throws a named error
   * when no signing key exists — the same refusal condition as the CLI path,
   * so an unsigned body a promote() reader would dead-letter is never written.
   */
  private signMailBody(to: string, body: string): string {
    const seed = readAgentPrivateKey(this.agentId, this.signingKeyPath);
    if (!seed) {
      const paths = this.signingKeyPath ? [this.signingKeyPath] : agentKeyCandidates(this.agentId);
      throw new Error(`no Ed25519 private key for agent "${this.agentId}" — refusing to send unsigned mail. Looked at ${paths.join(", then ")}. Provision the agent's key.`);
    }
    const now = new Date().toISOString();
    const chain: ChainEntry[] = [
      { agent: "system", kind: "human", timestamp: now, rationale: "agent runtime sendMail", signature: null },
      { agent: this.agentId, kind: "agent", timestamp: now, rationale: `agent ${this.agentId} sendMail`, signature: null },
    ];
    const envelope: Envelope = {
      v: 1,
      from: this.agentId,
      to,
      subject: `mail to ${to}`,
      body,
      messageId: randomUUID(),
      timestamp: now,
      delegationChain: chain,
    };
    return JSON.stringify(signEnvelope(envelope, { [this.agentId]: Buffer.from(seed) }));
  }

  /** Deliver all messages in outbox to recipient inboxes (local relay). */
  deliverOutbox(): void {
    if (!existsSync(this.outboxNew)) return;
    const files = readdirSync(this.outboxNew).filter(f => !f.startsWith("."));
    for (const file of files) {
      const srcPath = join(this.outboxNew, file);
      try {
        const raw = readFileSync(srcPath, "utf-8");
        const msg = JSON.parse(raw) as { to: string; body: string; sentAt: string };
        if (!msg.to || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.to)) {
          continue; // skip invalid recipients
        }
        const recipientInbox = join(this.mailDir, msg.to, "new");
        mkdirSync(recipientInbox, { recursive: true });
        const destFile = `${msg.sentAt.replace(/[:.]/g, "-")}-${file}`;
        renameSync(srcPath, join(recipientInbox, destFile));
      } catch {
        // Leave in outbox on error
      }
    }
  }

  /**
   * Parse a mail file and run the shared mailbox policy on its signed envelope.
   * Returns a terminal `{ pass: false, class, reason }` on a deterministic
   * rejection; a THROW (Flair unreachable) is a refusal the caller acts on,
   * never a pass.
   */
  private async verifyMailBody(body: string): Promise<VerifyOutcome> {
    let mailMsg: { from?: string; body: string };
    try {
      mailMsg = JSON.parse(body);
    } catch {
      return { pass: false, class: "invalid", reason: "json parse error: invalid JSON" };
    }

    const parsed = parseSignedEnvelope(mailMsg.body);
    if (!parsed.ok) return { pass: false, class: parsed.class, reason: parsed.reason, from: mailMsg.from };

    const decision = await decideEnvelopeForMailbox(this.agentId, parsed.envelope, mailMsg.from, this.flairClient)
      .catch((err: unknown) => {
        if (err instanceof PublicKeyFormatError) {
          return { ok: false as const, class: "invalid" as const, reason: `signature verification failed: ${err.message}` };
        }
        throw err;
      });
    if (!decision.ok) return { pass: false, class: decision.class, reason: decision.reason, from: mailMsg.from };
    return { pass: true, envelope: decision.envelope };
  }
}
