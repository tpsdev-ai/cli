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
 * The mailbox reject classes this path can emit. It uses the SHARED class NAMES
 * (`invalid`, `unresolvable-principal`, `wrong-recipient`) so a dlq sidecar it
 * writes is readable by the shared tooling. It is NOT the full shared class set:
 * this path emits only TERMINAL classes — an outage is refused, not
 * dead-lettered (the record stays in `new/`), so no retryable class is written
 * here.
 */
type MailboxRejectClass = "invalid" | "unresolvable-principal" | "wrong-recipient";

type VerifyOutcome =
  | { pass: true }
  | { pass: false; class: MailboxRejectClass; reason: string; from?: string };

/**
 * The stable reason string `verifyEnvelope` returns when an agent-kind chain
 * entry or `envelope.from` cannot be resolved from the LOCAL Flair. An ABSENT
 * principal is a topology condition, not a forgery verdict, so it is labelled
 * `unresolvable-principal` rather than `invalid`. Duplicated from the shared
 * promotion boundary because `@tpsdev-ai/agent` cannot import `packages/cli`
 * (the dependency runs the other way: cli → agent).
 */
const UNRESOLVABLE_PRINCIPAL_REASON_RE = /^agent (.+) not found in Flair$/;

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
        const dlqPath = join(this.inboxDlq, file);
        try {
          if (srcPath !== dlqPath) renameSync(srcPath, dlqPath);
          writeRejectSidecar(this.inboxDlq, file, verifyResult.class, verifyResult.reason);
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
   * Verify a mail body against the v1 signed envelope spec AND this mailbox's
   * policy: signature, wrapper→envelope `from` binding, recipient binding
   * (`envelope.to` must be this mailbox's agent), and `messageId`/`timestamp`
   * shape. These are the checks the shared `promote()` applies, so this path
   * cannot present mail the shared path would reject.
   *
   * Returns a terminal `{ pass: false, class, reason }` on a deterministic
   * rejection. Called ONLY when a verifier is configured; a THROW (Flair
   * unreachable) is a refusal the caller acts on, never a pass.
   */
  private async verifyMailBody(body: string): Promise<VerifyOutcome> {
    const client = this.flairClient!;

    // 1. Parse the mail file as JSON
    let mailMsg: { from?: string; body: string };
    try {
      mailMsg = JSON.parse(body);
    } catch {
      return { pass: false, class: "invalid", reason: "json parse error: invalid JSON" };
    }

    if (!mailMsg.body || typeof mailMsg.body !== "string") {
      return { pass: false, class: "invalid", reason: "json parse error: missing body field" };
    }

    // 2. Parse the body field as an envelope
    let envelope: unknown;
    try {
      envelope = JSON.parse(mailMsg.body);
    } catch {
      return { pass: false, class: "invalid", reason: "json parse error: invalid envelope body", from: mailMsg.from };
    }

    if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) {
      return { pass: false, class: "invalid", reason: "unsigned envelope (v1 required)", from: mailMsg.from };
    }

    const env = envelope as Record<string, unknown>;
    if (
      typeof env.v !== "number" ||
      !Array.isArray(env.delegationChain) ||
      typeof env.signature !== "string"
    ) {
      return { pass: false, class: "invalid", reason: "unsigned envelope (v1 required)", from: mailMsg.from };
    }

    // 3. Verify the signature. A THROW here (Flair unreachable) is NOT a pass —
    //    it propagates to checkNewMail(), which refuses to promote and leaves
    //    the record in new/ for a later check. The verifier adapter throws on an
    //    outage, so an outage is RETRYABLE rather than a terminal "not found".
    const vr = await verifyEnvelope(env as any, client);
    if (!vr.ok) {
      const cls: MailboxRejectClass = UNRESOLVABLE_PRINCIPAL_REASON_RE.test(vr.reason)
        ? "unresolvable-principal"
        : "invalid";
      return { pass: false, class: cls, reason: vr.reason, from: mailMsg.from };
    }

    // 4. The wrapper `from` is what consumers route by, and it is unverified; a
    //    wrapper/envelope mismatch is itself a reject.
    if (mailMsg.from !== env.from) {
      return {
        pass: false,
        class: "invalid",
        reason: `wrapper/envelope from mismatch (wrapper.from=${String(mailMsg.from)}, envelope.from=${String(env.from)})`,
        from: mailMsg.from,
      };
    }

    // 5. Recipient binding. A signature is NOT recipient-bound, so a correctly
    //    signed envelope addressed to another principal must not be presented
    //    here (deliverOutbox writes into any recipient's new/).
    if (env.to !== this.agentId) {
      return {
        pass: false,
        class: "wrong-recipient",
        reason: `wrong-recipient (envelope.to=${String(env.to)}, mailbox=${this.agentId})`,
        from: mailMsg.from,
      };
    }

    // 6. `messageId` shape.
    if (typeof env.messageId !== "string" || env.messageId.trim() === "") {
      return {
        pass: false,
        class: "invalid",
        reason: `invalid messageId (must be a non-empty string, got ${JSON.stringify(env.messageId)})`,
        from: mailMsg.from,
      };
    }

    // 7. `timestamp` shape — a malformed/absent timestamp must not be silently
    //    accepted (the shared path rejects it too).
    if (typeof env.timestamp !== "string" || Number.isNaN(Date.parse(env.timestamp))) {
      return {
        pass: false,
        class: "invalid",
        reason: `invalid timestamp (must be an ISO-8601 string, got ${JSON.stringify(env.timestamp)})`,
        from: mailMsg.from,
      };
    }

    return { pass: true };
  }
}
