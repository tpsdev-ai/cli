import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLogger } from "../telemetry/events.js";
import { sanitizeError } from "../telemetry/events.js";

export interface MailMessage {
  filename: string;
  body: string;
  receivedAt: Date;
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

  constructor(
    public readonly mailDir: string,
    private readonly events?: EventLogger,
    private readonly agentId = "unknown",
  ) {
    this.inboxNew = join(mailDir, "inbox", "new");
    this.inboxCur = join(mailDir, "inbox", "cur");
    this.outboxNew = join(mailDir, "outbox", "new");
    for (const dir of [this.inboxNew, this.inboxCur, this.outboxNew]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Return all messages in inbox/new and move them to inbox/cur. */
  async checkNewMail(): Promise<MailMessage[]> {
    if (!existsSync(this.inboxNew)) return [];

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith(".") && !f.includes("/") && !f.includes("\\"));
    const messages: MailMessage[] = [];

    for (const file of files) {
      const started = Date.now();
      const srcPath = join(this.inboxNew, file);
      const dstPath = join(this.inboxCur, file);
      try {
        const body = readFileSync(srcPath, "utf-8");
        renameSync(srcPath, dstPath);
        messages.push({ filename: file, body, receivedAt: new Date() });
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "ok",
          from: "unknown",
          durationMs: Date.now() - started,
        });
      } catch (err) {
        this.events?.emit({
          type: "mail.receive",
          agent: this.agentId,
          status: "error",
          from: "unknown",
          durationMs: Date.now() - started,
          subject: sanitizeError(err),
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
        subject: sanitizeError(err),
      });
      throw err;
    }
  }
}
