import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { signEnvelope, type ChainEntry, type Envelope, type FlairClient } from "../lib/signEnvelope.js";
import { agentKeyCandidates, readAgentPrivateKey } from "../lib/agent-keys.js";
import { acquireMailLock, type MailLock } from "../lib/mail-lock.js";
import {
  decideEnvelopeForMailbox,
  type MailboxPolicyRejectClass,
  mailboxReplayStore,
  parseSignedEnvelope,
} from "../lib/mailbox-policy.js";

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

/**
 * Maildir-compatible mail client.
 * Reads from mailDir/inbox/new and moves processed messages to mailDir/inbox/cur.
 * Writes outgoing mail to mailDir/outbox/new.
 */
export class MailClient {
  private mailboxRoot: string;
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
    this.inboxNew = join(mailDir, agentId, "new");
    this.inboxCur = join(mailDir, agentId, "cur");
    this.inboxDlq = join(mailDir, agentId, "dlq");
    this.outboxNew = join(mailDir, agentId, "outbox");
    for (const dir of [this.inboxNew, this.inboxCur, this.inboxDlq, this.outboxNew]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Return all messages in inbox/new and move them to inbox/cur/.
   *
   * A record is promoted ONLY after the shared mailbox policy
   * (decideEnvelopeForMailbox) passes and, under the mailbox lock, the shared
   * replay store has not seen its messageId:
   *   - the verifier THROWS (Flair unreachable) → refuse; the record stays in
   *     new/ for a later check (a throw must never mean "pass");
   *   - the policy or the replay gate REJECTS → attempt dead-lettering and a
   *     `.reason` sidecar.
   */
  async checkNewMail(): Promise<MailMessage[]> {
    if (!existsSync(this.inboxNew)) return [];

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));
    const messages: MailMessage[] = [];

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

      // Promote to cur/ under the mailbox lock, behind the replay gate.
      try {
        const committed = await this.commitToCur(file, srcPath, body, verifyResult.envelope);
        if (committed) {
          this.deadLetter(file, srcPath, { ...committed, from: verifyResult.envelope.from }, started);
          continue;
        }
        const from = verifyResult.envelope.from;
        messages.push({
          filename: file, body, receivedAt: new Date(), headers: {}, from,
          verifiedEnvelope: verifyResult.envelope,
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
   * Under the mailbox lock: refuse a consumed messageId, else rename into cur/
   * and record the id. Returns the replay rejection, or null once committed.
   * On append failure, attempt to move the record back to new/; throw on failure.
   */
  private async commitToCur(
    file: string,
    srcPath: string,
    body: string,
    envelope: Envelope,
  ): Promise<{ pass: false; class: MailboxRejectClass; reason: string } | null> {
    const lock: MailLock | null = await acquireMailLock(this.mailboxRoot);
    if (!lock) throw new Error("mailbox lock busy; not promoted");
    try {
      if (readFileSync(srcPath, "utf-8") !== body) throw new Error("source changed during promotion; not promoted");
      const replay = mailboxReplayStore(this.mailboxRoot);
      if (replay.isConsumed(envelope.messageId)) {
        return { pass: false, class: "replay", reason: `replay (envelope messageId ${envelope.messageId} already consumed)` };
      }
      const dstPath = join(this.inboxCur, file);
      renameSync(srcPath, dstPath);
      try {
        replay.recordConsumed(envelope.messageId);
      } catch (err) {
        try {
          renameSync(dstPath, srcPath);
        } catch (rollbackErr) {
          throw new AggregateError([err, rollbackErr],
            `mail commit failed: ${sanitizeError(err)}; rollback failed: ${sanitizeError(rollbackErr)}`);
        }
        throw err;
      }
      return null;
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
    try {
      if (srcPath !== dlqPath) renameSync(srcPath, dlqPath);
      writeRejectSidecar(this.inboxDlq, file, rejected.class, rejected.reason);
    } catch (err) {
      console.error(`[MailClient] failed to dead-letter ${file}: ${sanitizeError(err)}`);
    }
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

    const decision = await decideEnvelopeForMailbox(this.agentId, parsed.envelope, mailMsg.from, this.flairClient);
    if (!decision.ok) return { pass: false, class: decision.class, reason: decision.reason, from: mailMsg.from };
    return { pass: true, envelope: decision.envelope };
  }
}
