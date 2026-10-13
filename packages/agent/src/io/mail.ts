import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { signEnvelope, type ChainEntry, type Envelope, type FlairClient } from "../lib/signEnvelope.js";
import { PublicKeyFormatError } from "../lib/public-key.js";
import { agentKeyCandidates, readAgentPrivateKey } from "../lib/agent-keys.js";
import { tryAcquireRelayMoveLock } from "../lib/relay-lock.js";
import { mailboxLockRoot } from "../lib/mail-lock-namespace.js";
import { acquireMailLock, type MailLock } from "../lib/mail-lock.js";
import {
  decideEnvelopeForMailbox,
  type MailboxPolicyRejectClass,
  mailboxReplayStore,
  parseSignedEnvelope,
  pendingPlacementEntries,
  type PlacementPhase,
  placeCurRecord,
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
 * re-presents an `in_progress` intent through its own completion-gated path
 * (`recoverDelivery`), not this one.
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
  private mailboxRoot: string;
  private readonly mailboxLockRoot: string;
  private inboxNew: string;
  private inboxCur: string;
  private inboxDlq: string;
  private outboxNew: string;
  private readonly flairClient: FlairClient;

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
    this.mailboxRoot = join(mailDir, agentId);
    // cli#616: promotion locks the mailbox under the resolved real path of the
    // configured mail directory (see mail-lock-namespace.ts). Placement recovery
    // locks `mailboxRoot` as given; both reach one filesystem lock.
    this.mailboxLockRoot = mailboxLockRoot(mailDir, agentId);
    this.inboxNew = join(mailDir, agentId, "new");
    this.inboxCur = join(mailDir, agentId, "cur");
    this.inboxDlq = join(mailDir, agentId, "dlq");
    this.outboxNew = join(mailDir, agentId, "outbox");
    for (const dir of [this.inboxNew, this.inboxCur, this.inboxDlq, this.outboxNew]) {
      mkdirSync(dir, { recursive: true });
    }
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
        if (committed === "already-delivered") continue;
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
   * cli#617 slice (b): the per-message delivery API, inert until slice (c)
   * wires the event loop. It returns at most ONE message:
   *
   *  1. a committed message whose placement intent is live — a `placing`
   *     intent finished to `in_progress`, or an `in_progress` re-presentation.
   *     Recovery is completion-gated, and the liveness bound turns a message
   *     that is never completed into a terminal `failed` intent;
   *  2. otherwise the next verified `new/` message, committed to `cur/` with
   *     its intent left in the `in_progress` phase. Later messages stay in
   *     `new/`.
   *
   * The caller finalizes with completeDelivery() after the handler
   * completes; a crash or stop before that re-presents the same message on the
   * next call. The delivery key is mailbox + messageId.
   */
  async deliverNext(): Promise<MailMessage | null> {
    const recovered = await this.recoverDelivery();
    if (recovered) return recovered;
    return this.commitNextForDelivery();
  }

  /**
   * cli#617 slice (b): the completion-only finalize for a message handed over
   * by deliverNext(). Deletes the message's `in_progress` intent in its own
   * synchronous mailbox-lock section; returns whether an intent was removed.
   * Idempotent: a message already finalized leaves nothing to delete.
   */
  async completeDelivery(message: MailMessage): Promise<boolean> {
    const messageId = message.verifiedEnvelope?.messageId;
    if (typeof messageId !== "string" || messageId === "") {
      throw new Error("completeDelivery requires a delivered message carrying its verified envelope");
    }
    const lock = await acquireMailLock(this.mailboxRoot);
    if (!lock) throw new Error("mailbox lock busy; delivery not finalized");
    try {
      return mailboxReplayStore(this.mailboxRoot).completePlacement(messageId, message.filename);
    } finally {
      lock.release();
    }
  }

  /**
   * cli#617 slice (b): completion-gated recovery for deliverNext(). A `placing`
   * intent is finished and moved to `in_progress`; an `in_progress` intent is
   * re-presented; `unknown` is skipped (never presented or finished). Returns
   * the first message presented, or null.
   */
  private async recoverDelivery(): Promise<MailMessage | null> {
    let pending: Array<{ messageId: string; file: string; phase: PlacementPhase }>;
    let listing: MailLock | null = null;
    try {
      listing = await acquireMailLock(this.mailboxRoot);
      if (!listing) return null;
      pending = pendingPlacementEntries(this.mailboxRoot);
    } catch (err) {
      this.emitRecoveryError(err);
      return null;
    } finally {
      listing?.release();
    }
    for (const { messageId, file, phase } of pending) {
      if (phase === "unknown") continue;
      try {
        const presented = await this.presentPendingDelivery(messageId, file);
        if (presented) return presented;
      } catch (err) {
        this.emitRecoveryError(err);
      }
    }
    return null;
  }

  /** Re-verify a pending cur/ copy and present it under the lock, honoring the liveness bound. */
  private async presentPendingDelivery(messageId: string, file: string): Promise<MailMessage | null> {
    const curPath = join(this.inboxCur, file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(curPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Same unlinked-placement cleanup as slice (a): finish only a `placing`
      // intent whose cur/ copy is absent.
      await this.finishUnlinkedPlacement(messageId, file);
      return null;
    }
    const outcome = await this.verifyMailBody(bytes.toString("utf8"));
    if (!outcome.pass || outcome.envelope.messageId !== messageId) return null;
    const trustTier = verifiedMailTier(outcome.envelope, this.mailDir);
    return this.presentUnderLock(messageId, file, bytes, outcome.envelope, trustTier);
  }

  /**
   * Re-read the intent, identity and raw bytes under the lock (the phase may
   * have changed since the listing), advance the presentation and return the
   * message. A bound hit writes the terminal `failed` phase and the named log
   * line, and presents nothing.
   */
  private async presentUnderLock(
    messageId: string,
    file: string,
    bytes: Buffer,
    envelope: Envelope,
    trustTier: MailMessage["trustTier"],
  ): Promise<MailMessage | null> {
    const lock = await acquireMailLock(this.mailboxRoot);
    if (!lock) throw new Error("mailbox lock busy; delivery recovery deferred");
    try {
      const replay = mailboxReplayStore(this.mailboxRoot);
      if (!replay.hasPendingPlacement(messageId, file)) return null;
      const phase = replay.placementPhase(file);
      if (phase === null || phase === "unknown") return null;
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
      const advance = replay.advancePresentation(messageId, file, new Date().toISOString());
      if (advance.status === "absent") return null;
      if (advance.status === "failed") {
        console.warn(
          `[MailClient] placement quarantined for mailbox ${this.agentId}: message ${messageId} not completed ` +
            `after ${advance.presentations} presentation(s); payload retained for the operator`,
        );
        return null;
      }
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

  /** Commit the next verifiable new/ message to cur/ with a live `in_progress` intent, or null. */
  private async commitNextForDelivery(): Promise<MailMessage | null> {
    if (!existsSync(this.inboxNew)) return null;
    const files = readdirSync(this.inboxNew)
      .filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"))
      .sort();
    for (const file of files) {
      const started = Date.now();
      const srcPath = join(this.inboxNew, file);
      let body: string;
      try {
        body = readFileSync(srcPath, "utf-8");
      } catch (err) {
        this.emitRecoveryError(err);
        continue;
      }
      let verifyResult: VerifyOutcome;
      try {
        verifyResult = await this.verifyMailBody(body);
      } catch (err) {
        this.emitRecoveryError(err); // leave in new/ for a later call
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
        continue;
      }
      try {
        const committed = await this.commitToCur(file, srcPath, body, verifyResult.envelope, true);
        if (committed === "already-delivered") continue;
        if (committed) {
          this.deadLetter(file, srcPath, { ...committed, from: verifyResult.envelope.from }, started);
          continue;
        }
        const from = verifyResult.envelope.from;
        this.events?.emit({
          type: "mail.receive", agent: this.agentId, status: "ok", from, durationMs: Date.now() - started,
        });
        return {
          filename: file, body, receivedAt: new Date(), headers: {}, from,
          verifiedEnvelope: verifyResult.envelope, trustTier,
        };
      } catch (err) {
        this.emitRecoveryError(err);
      }
    }
    return null;
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
    keepInProgress = false,
  ): Promise<{ pass: false; class: MailboxRejectClass; reason: string } | "already-delivered" | null> {
    const lock: MailLock | null = await acquireMailLock(this.mailboxLockRoot);
    if (!lock) throw new Error("mailbox lock busy; not promoted");
    let relayLock: MailLock | null;
    try { relayLock = tryAcquireRelayMoveLock(JSON.parse(body), this.mailDir); }
    catch (error) { lock.release(); throw error; }
    if (!relayLock) { lock.release(); throw new Error("relay acceptance busy; not promoted"); }
    try {
      if (readFileSync(srcPath, "utf-8") !== body) throw new Error("source changed during promotion; not promoted");
      const replay = mailboxReplayStore(this.mailboxRoot);
      if (replay.hasPendingFile(file)) throw new Error(`pending placement unresolved: ${file}`);
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
      if (keepInProgress) {
        // cli#617 slice (b): the delivery API leaves the intent live, in the
        // `in_progress` phase (presentation 1), for the caller to finalize on
        // completion. The batch checkNewMail() path finalizes as before.
        const advance = replay.advancePresentation(envelope.messageId, file, new Date().toISOString());
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
