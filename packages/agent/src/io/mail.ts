import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";
import { verifyEnvelope, type FlairClient } from "@tpsdev-ai/cli/lib/signEnvelope";

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
 * Maildir-compatible mail client.
 * Reads from mailDir/inbox/new and moves processed messages to mailDir/inbox/cur.
 * Writes outgoing mail to mailDir/outbox/new.
 */
export class MailClient {
  private inboxNew: string;
  private inboxCur: string;
  private outboxNew: string;

  private inboxDlq: string;

  constructor(
    public readonly mailDir: string,
    private readonly events?: EventLogger,
    private readonly agentId = "unknown",
    private readonly flailClient?: FlairClient,
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
   * Return all messages in inbox/new and move them to inbox/cur.
   * When a FlairClient is provided, signed envelopes are verified
   * before promotion; invalid/malformed messages go to dlq/.
   */
  async checkNewMail(): Promise<MailMessage[]> {
    if (!existsSync(this.inboxNew)) return [];

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));
    const messages: MailMessage[] = [];

    for (const file of files) {
      const started = Date.now();
      const srcPath = join(this.inboxNew, file);
      try {
        const body = readFileSync(srcPath, "utf-8");

        // Envelope verification (strict when FlairClient is available).
        if (this.flailClient) {
          const verifyResult = await this.verifyMailBody(body, file);
          if (!verifyResult.pass) {
            // Move to dlq/ with .reject sidecar
            const dlqPath = join(this.inboxDlq, file);
            renameSync(srcPath, dlqPath);
            writeFileSync(join(this.inboxDlq, `${file}.reject`), verifyResult.reason, "utf-8");
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
        }

        // Promote to cur/
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
   * Returns { pass: true } if verified, or { pass: false, reason: "..." } on failure.
   * Requires flailClient to be set.
   */
  private async verifyMailBody(
    body: string,
    _filename: string,
  ): Promise<{ pass: true } | { pass: false; reason: string; from?: string }> {
    const client = this.flailClient!;

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

    // 3. Verify the envelope using the Flair-backed client
    try {
      const vr = await verifyEnvelope(env as any, client);
      if (!vr.ok) {
        return { pass: false, reason: vr.reason, from: mailMsg.from };
      }
    } catch (err: any) {
      // verifyEnvelope threw (e.g. Flair network error).
      // Don't drop the message — pass it through and log.
      console.warn(`[MailClient] verifyEnvelope error for ${_filename}: ${err?.message ?? err}`);
    }

    return { pass: true };
  }
}