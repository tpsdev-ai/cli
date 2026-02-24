import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

  constructor(public readonly mailDir: string) {
    this.inboxNew = join(mailDir, "inbox", "new");
    this.inboxCur = join(mailDir, "inbox", "cur");
    this.outboxNew = join(mailDir, "outbox", "new");
    // Ensure directories exist
    for (const dir of [this.inboxNew, this.inboxCur, this.outboxNew]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Return all messages in inbox/new and move them to inbox/cur. */
  async checkNewMail(): Promise<MailMessage[]> {
    if (!existsSync(this.inboxNew)) return [];

    const files = readdirSync(this.inboxNew).filter((f) => !f.startsWith("."));
    const messages: MailMessage[] = [];

    for (const file of files) {
      const srcPath = join(this.inboxNew, file);
      const dstPath = join(this.inboxCur, file);
      const body = readFileSync(srcPath, "utf-8");
      renameSync(srcPath, dstPath);
      messages.push({ filename: file, body, receivedAt: new Date() });
    }

    return messages;
  }

  /** Write a message to outbox/new for relay delivery. */
  async sendMail(to: string, body: string): Promise<void> {
    const { writeFileSync } = await import("node:fs");
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(
      join(this.outboxNew, filename),
      JSON.stringify({ to, body, sentAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );
  }
}
