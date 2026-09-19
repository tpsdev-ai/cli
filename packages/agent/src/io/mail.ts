import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { verifyEnvelope, type FlairClient } from "../lib/signEnvelope.js";

export interface MailMessage {
  filename: string;
  body: string;
  receivedAt: Date;
  /** Trust/routing headers from bridge envelope */
  headers: Record<string, string>;
  /** Sender agent ID */
  from: string;
}

/**
 * The stable reason string `verifyEnvelope` returns when an agent-kind chain
 * entry or `envelope.from` cannot be resolved from the LOCAL Flair. Mirrors the
 * shared promote() reject-class boundary (packages/cli/src/utils/mail.ts): a
 * principal that is merely ABSENT is a topology condition, not a forgery
 * verdict, so the dlq sidecar must not label it `invalid`. Duplicated here
 * because `@tpsdev-ai/agent` cannot import `packages/cli` (the dependency runs
 * the other way: cli → agent).
 */
const UNRESOLVABLE_PRINCIPAL_REASON_RE = /^agent (.+) not found in Flair$/;

/**
 * Write the dlq sidecar for a rejected record in the SHARED convention: first
 * line `class: <class>`, then the reason (the same file name and shape the
 * shared re-drive's `readReasonSidecar` parses, so a `tps mail check <agent>`
 * over the same mailbox root can classify a record this path quarantined).
 * (This path previously wrote `${file}.reject` with a bare reason, which no
 * shared reader scans.)
 */
function writeRejectSidecar(dlqDir: string, filename: string, reason: string): void {
  const cls = UNRESOLVABLE_PRINCIPAL_REASON_RE.test(reason) ? "unresolvable-principal" : "invalid";
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
  private inboxNew: string;
  private inboxCur: string;
  private inboxDlq: string;
  private outboxNew: string;
  /** One-shot guard so a misconfigured (verifier-less) mailbox warns once, not per poll. */
  private warnedNoVerifier = false;

  constructor(
    public readonly mailDir: string,
    private readonly events?: EventLogger,
    private readonly agentId = "unknown",
    private readonly flairClient?: FlairClient,
  ) {
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
   * Verification is MANDATORY — a record is promoted ONLY after its signed
   * envelope verifies against the local Flair. There is no unverified path:
   *   - NO verifier configured → refuse; the record stays in new/ (an absent
   *     client must never mean "promote without verifying");
   *   - the verifier THROWS (Flair unreachable) → refuse; the record stays in
   *     new/ for a later check (a throw must never mean "pass");
   *   - the verifier REJECTS → dead-letter to dlq/ with a `.reason` sidecar.
   * Unverified input must never reach the tool-holding model.
   */
  async checkNewMail(): Promise<MailMessage[]> {
    if (!existsSync(this.inboxNew)) return [];

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));
    const messages: MailMessage[] = [];

    // No verifier → NOTHING is promotable. Refuse (never rename into cur/) and
    // leave the records in new/ so a later check with a verifier — or the
    // shared promote() path — can process them.
    if (!this.flairClient) {
      if (files.length === 0) return [];
      this.events?.emit({
        type: "mail.receive",
        agent: this.agentId,
        status: "rejected",
        from: "unknown",
        durationMs: 0,
        error: "no verifier configured — refusing to promote unverified mail",
      });
      if (!this.warnedNoVerifier) {
        this.warnedNoVerifier = true;
        console.error(
          `[MailClient] no Flair verifier configured for "${this.agentId}": refusing to promote ` +
            `${files.length} unverified message(s) from new/. Unverified input must never reach the ` +
            `model — configure flair (url + key) or promote through the shared promote() lifecycle.`,
        );
      }
      return [];
    }

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
      let verifyResult: { pass: true } | { pass: false; reason: string; from?: string };
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
        const dlqPath = join(this.inboxDlq, file);
        try {
          if (srcPath !== dlqPath) renameSync(srcPath, dlqPath);
          writeRejectSidecar(this.inboxDlq, file, verifyResult.reason);
        } catch (err) {
          console.error(`[MailClient] failed to dead-letter ${file}: ${sanitizeError(err)}`);
        }
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "rejected",
          from: verifyResult.from ?? "unknown",
          durationMs: Date.now() - started,
          error: verifyResult.reason,
        });
        continue;
      }

      // Promote to cur/ — verified, and addressed to this mailbox.
      try {
        const dstPath = join(this.inboxCur, file);
        renameSync(srcPath, dstPath);
        let headers: Record<string, string> = {};
        let from = "unknown";
        try {
          const parsed = JSON.parse(body);
          headers = parsed.headers ?? {};
          from = parsed.from ?? "unknown";
        } catch {}
        messages.push({ filename: file, body, receivedAt: new Date(), headers, from });
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

  /** Write a message to outbox/new for relay delivery. */
  async sendMail(to: string, body: string): Promise<void> {
    const started = Date.now();
    try {
      const { writeFileSync } = await import("node:fs");
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      writeFileSync(
        join(this.outboxNew, filename),
        JSON.stringify({ to, body, sentAt: new Date().toISOString() }, null, 2),
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
   * Verify a mail body against the v1 signed envelope spec.
   * Returns { pass: true } if verified, or { pass: false, reason: "..." } on a
   * deterministic rejection. Called ONLY when a verifier is configured; a THROW
   * (e.g. Flair unreachable) is a refusal the caller acts on, never a pass.
   */
  private async verifyMailBody(
    body: string,
  ): Promise<{ pass: true } | { pass: false; reason: string; from?: string }> {
    const client = this.flairClient!;

    // 1. Parse the mail file as JSON
    let mailMsg: { from?: string; body: string };
    try {
      mailMsg = JSON.parse(body);
    } catch {
      return { pass: false, reason: "json parse error: invalid JSON" };
    }

    if (!mailMsg.body || typeof mailMsg.body !== "string") {
      return { pass: false, reason: "json parse error: missing body field" };
    }

    // 2. Parse the body field as an envelope
    let envelope: unknown;
    try {
      envelope = JSON.parse(mailMsg.body);
    } catch {
      return { pass: false, reason: "json parse error: invalid envelope body", from: mailMsg.from };
    }

    if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) {
      return { pass: false, reason: "unsigned envelope (v1 required)", from: mailMsg.from };
    }

    const env = envelope as Record<string, unknown>;
    if (
      typeof env.v !== "number" ||
      !Array.isArray(env.delegationChain) ||
      typeof env.signature !== "string"
    ) {
      return { pass: false, reason: "unsigned envelope (v1 required)", from: mailMsg.from };
    }

    // 3. Verify the envelope using the canonical verifyEnvelope.
    //    A THROW here (e.g. Flair unreachable) is NOT a pass — it propagates to
    //    checkNewMail(), which refuses to promote. Swallowing it and returning
    //    { pass: true } was fail-OPEN: a deliberate "don't drop the message"
    //    that promoted unverified mail straight into the model during a Flair
    //    outage. Verification must be a refusal when it cannot run.
    const vr = await verifyEnvelope(env as any, client);
    if (!vr.ok) {
      return { pass: false, reason: vr.reason, from: mailMsg.from };
    }

    return { pass: true };
  }
}
