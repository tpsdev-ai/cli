import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { signEnvelope, type ChainEntry, type Envelope, type FlairClient } from "../lib/signEnvelope.js";
import { PublicKeyFormatError } from "../lib/public-key.js";
import { agentKeyCandidates, readAgentPrivateKey } from "../lib/agent-keys.js";
import { tryAcquireRelayMoveLock } from "../lib/relay-lock.js";
import { canonicalMailboxRoot, canonicalMailRoot } from "../lib/mail-lock-namespace.js";
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
 * payload was read and verified. Slice (b) defines the re-presentation of
 * `in_progress`.
 */
function resumableOnRecovery(phase: PlacementPhase | null): boolean {
  return phase === "placing";
}

/**
 * cli#636: the roots one MailClient operation uses, resolved once when the
 * operation starts and passed to every step of it. Each is the resolved real
 * path (symlinks and `.`/`..` resolved) at that moment; paths beneath them
 * (`new/`, `cur/`, a file) are joined to them, not resolved again. A later
 * operation resolves them afresh, so when the symlink at the configured mail
 * path or at the agent's mailbox directory is repointed, the new target is
 * selected at the start of the next operation and an operation already running
 * finishes against the target it started with.
 */
interface OperationRoots {
  /** The configured mail directory: bridge-principal trust, acceptance stripes, recipient inboxes. */
  readonly mailRoot: string;
  /** This agent's mailbox directory: the mailbox lock, the maildir paths and the replay state. */
  readonly mailbox: string;
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
    // cli#636: create the maildir under the target configured now. Nothing is
    // kept: every operation resolves its own roots (operationRoots).
    this.operationRoots();
  }

  /**
   * cli#636: resolve the roots for one operation (see OperationRoots) and create
   * the maildir subdirectories under the mailbox. The mail root is the resolved
   * real path of the configured `mailDir`; the mailbox is the resolved real path
   * of `<mail root>/<agentId>`, so a symlink at the mailbox directory itself is
   * resolved too. Both are resolved through mail-lock-namespace.ts (cli#616).
   */
  private operationRoots(): OperationRoots {
    const mailRoot = canonicalMailRoot(this.mailDir);
    // Create the mailbox with the default mode first (canonicalMailboxRoot
    // would create it 0700); resolving it then creates nothing.
    mkdirSync(join(mailRoot, this.agentId), { recursive: true });
    const mailbox = canonicalMailboxRoot(join(mailRoot, this.agentId));
    for (const dir of ["new", "cur", "dlq", "outbox"]) mkdirSync(join(mailbox, dir), { recursive: true });
    return { mailRoot, mailbox };
  }

  async checkNewMail(): Promise<MailMessage[]> {
    const messages: MailMessage[] = [];
    const roots = this.operationRoots();
    await this.recoverInterruptedPlacements(messages, roots);
    const inboxNew = join(roots.mailbox, "new");
    if (!existsSync(inboxNew)) return messages;

    const files = readdirSync(inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));

    for (const file of files) {
      const started = Date.now();
      const srcPath = join(inboxNew, file);

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
        this.deadLetter(file, srcPath, verifyResult, started, roots);
        continue;
      }

      let trustTier: MailMessage["trustTier"];
      try {
        trustTier = verifiedMailTier(verifyResult.envelope, roots.mailRoot);
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
        const committed = await this.commitToCur(roots, file, srcPath, body, verifyResult.envelope);
        if (committed === "already-delivered") continue;
        if (committed) {
          this.deadLetter(file, srcPath, { ...committed, from: verifyResult.envelope.from }, started, roots);
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

  /** Commit under the mailbox lock; attempt placement rollback on append failure. */
  private async commitToCur(
    roots: OperationRoots,
    file: string,
    srcPath: string,
    body: string,
    envelope: Envelope,
  ): Promise<{ pass: false; class: MailboxRejectClass; reason: string } | "already-delivered" | null> {
    const lock: MailLock | null = await acquireMailLock(roots.mailbox);
    if (!lock) throw new Error("mailbox lock busy; not promoted");
    let relayLock: MailLock | null;
    try { relayLock = tryAcquireRelayMoveLock(JSON.parse(body), roots.mailRoot); }
    catch (error) { lock.release(); throw error; }
    if (!relayLock) { lock.release(); throw new Error("relay acceptance busy; not promoted"); }
    try {
      if (readFileSync(srcPath, "utf-8") !== body) throw new Error("source changed during promotion; not promoted");
      const replay = mailboxReplayStore(roots.mailbox);
      if (replay.hasPendingFile(file)) throw new Error(`pending placement unresolved: ${file}`);
      const dstPath = join(roots.mailbox, "cur", file);
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
      replay.finishPlacement(envelope.messageId, file);
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
  private async recoverInterruptedPlacements(messages: MailMessage[], roots: OperationRoots): Promise<void> {
    const root = roots.mailbox;
    let pending: Array<{ messageId: string; file: string; phase: PlacementPhase }>;
    let listing: MailLock | null = null;
    try {
      listing = await acquireMailLock(root);
      if (!listing) return; // lock unavailable; defer recovery
      pending = pendingPlacementEntries(root);
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
      const curPath = join(root, "cur", file);
      try {
        let bytes: Buffer;
        try {
          bytes = readFileSync(curPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          // Observed absent; re-check under the lock before finishing the intent.
          await this.finishUnlinkedPlacement(messageId, file, root);
          continue;
        }
        const outcome = await this.verifyMailBody(bytes.toString("utf8"));
        if (!outcome.pass) continue; // withhold: the cur copy is not a verified message
        const trustTier = verifiedMailTier(outcome.envelope, roots.mailRoot);
        const delivered = await this.completeInterruptedPlacement(messageId, file, root, bytes, outcome.envelope, trustTier);
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
  private async finishUnlinkedPlacement(messageId: string, file: string, root: string): Promise<void> {
    const lock = await acquireMailLock(root);
    if (!lock) return;
    try {
      const replay = mailboxReplayStore(root);
      if (!replay.hasPendingPlacement(messageId, file)) return;
      if (!resumableOnRecovery(replay.placementPhase(file))) return;
      if (lstatOrAbsent(join(root, "cur", file)) !== null) return;
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
    root: string,
    bytes: Buffer,
    envelope: Envelope,
    trustTier: MailMessage["trustTier"],
  ): Promise<MailMessage | null> {
    const lock = await acquireMailLock(root);
    if (!lock) throw new Error("mailbox lock busy; interrupted placement recovery deferred");
    try {
      const replay = mailboxReplayStore(root);
      // Match the intent, recorded device/inode and pre-verification raw bytes.
      if (!replay.hasPendingPlacement(messageId, file)) return null;
      if (!resumableOnRecovery(replay.placementPhase(file))) return null;
      if (envelope.messageId !== messageId) return null;
      if (!replay.ownsPendingPlacement(messageId, file)) return null;
      let current: Buffer;
      try {
        current = readFileSync(join(root, "cur", file));
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
    roots: OperationRoots,
  ): void {
    const dlqDir = join(roots.mailbox, "dlq");
    const dlqPath = join(dlqDir, file);
    let relayLock: MailLock | null = null;
    try {
      let record: unknown;
      try { record = JSON.parse(readFileSync(srcPath, "utf-8")); } catch {}
      relayLock = tryAcquireRelayMoveLock(record, roots.mailRoot);
      if (!relayLock) return;
      if (srcPath !== dlqPath) renameSync(srcPath, dlqPath);
      writeRejectSidecar(dlqDir, file, rejected.class, rejected.reason);
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
      const { mailbox } = this.operationRoots();
      const { writeFileSync } = await import("node:fs");
      // Sign the body as this agent — the v1 envelope a promote() reader
      // verifies. signMailBody THROWS when no key exists, so an unsigned body
      // is never written.
      const signed = this.signMailBody(to, body);
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      writeFileSync(
        join(mailbox, "outbox", filename),
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
    const roots = this.operationRoots();
    const outboxNew = join(roots.mailbox, "outbox");
    if (!existsSync(outboxNew)) return;
    const files = readdirSync(outboxNew).filter(f => !f.startsWith("."));
    for (const file of files) {
      const srcPath = join(outboxNew, file);
      try {
        const raw = readFileSync(srcPath, "utf-8");
        const msg = JSON.parse(raw) as { to: string; body: string; sentAt: string };
        if (!msg.to || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.to)) {
          continue; // skip invalid recipients
        }
        const recipientInbox = join(roots.mailRoot, msg.to, "new");
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
