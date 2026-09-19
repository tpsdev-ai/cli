/**
 * runtime-mail.ts — the promote() LIFECYCLE for the agent runtimes.
 *
 * The three runtimes (gemini / codex / claude-code) each carried a private
 * `checkNewMail()` that renamed `new/`→`cur/` and handed the body to a spawned
 * model with tool access. That is the invariant violation cli#380 is about:
 * `cur/` is a DESTINATION, and the only transition into it is `promote()`.
 *
 * Adopting `promote()` is not enough on its own — "delete checkNewMail; call
 * promote()" CREATES defects, because the caller half is where cli#377's
 * divergence lesson lives. This module owns that half so all three runtimes
 * share one lifecycle:
 *
 *   1. pollRuntimeMail()     — checkMessages(): promote `new/` through the one
 *      enforcement point, RE-DRIVE retryable `dlq/` so an outage self-heals, and
 *      RECOVER + lease-sweep `cur/` so a crash does not strand mail and an
 *      un-acked record is re-presented;
 *   2. sendRuntimeMail()     — sign every outbound body. A `promote()`-reading
 *      recipient dead-letters an unsigned body TERMINAL, so an unsigned reply is
 *      a dead letterbox; the signing path honors the runtime's configured
 *      `flairKeyPath` and refuses to fall back to unsigned;
 *   3. completeRuntimeMail() — ack AFTER the completion boundary (reply
 *      persisted AND any auto-commit finished). Acking is what stops cli#377's
 *      lease sweep re-presenting — and re-dispatching to a tool-holding model —
 *      a finished task forever;
 *   4. runtimeBootPreflight() — one Flair check at boot, loud on failure.
 *
 * Mailbox root: promotion, recovery, replies and acknowledgement all resolve
 * through getInbox()/sendMessage() in utils/mail.ts — the ONE mailbox resolver —
 * so a runtime cannot poll one root (its `config.mailDir`) while acknowledging
 * into another (a branch-office root). Passing runtime-scoped verification
 * config keeps each runtime's Flair endpoint/key from leaking process-wide.
 */

import { ackMessage, checkMessages, sendMessage, type MailMessage } from "./mail.js";
import { signOutboundBody } from "./mail-sign.js";
import snooplogg from "snooplogg";

const { log: slog, warn: swarn } = snooplogg("tps:runtime-mail");

export interface RuntimeMailConfig {
  agentId: string;
  /** Flair endpoint used to VERIFY inbound envelopes (runtime-scoped). */
  flairUrl?: string;
  /** Ed25519 key used to authenticate verification reads AND sign outbound. */
  flairKeyPath: string;
}

/**
 * Poll the mailbox: promote `new/`, re-drive retryable `dlq/`, recover +
 * lease-sweep `cur/`. Returns the messages that are presentable to the runtime.
 *
 * `checkedOutBy` is the agent itself, matching the historical runtime loop.
 * The runtime-scoped verify config is threaded so verification uses the endpoint
 * and key the runtime is ALREADY configured with (mandatory verification stays;
 * only its endpoint resolution is runtime-scoped).
 */
export async function pollRuntimeMail(cfg: RuntimeMailConfig): Promise<MailMessage[]> {
  return checkMessages(cfg.agentId, cfg.agentId, {
    flairUrl: cfg.flairUrl,
    flairKeyPath: cfg.flairKeyPath,
  });
}

/**
 * Send a SIGNED reply/notification into a peer's mailbox.
 *
 * The body is wrapped in a v1 signed envelope (the only shape a
 * `promote()`-reading recipient accepts) using the runtime's configured key.
 * If the key is missing this THROWS rather than shipping an unsigned dead
 * letter — a runtime that cannot sign cannot deliver a usable reply.
 */
export function sendRuntimeMail(cfg: RuntimeMailConfig, to: string, body: string): void {
  const signed = signOutboundBody(cfg.agentId, to, body, {
    keyPath: cfg.flairKeyPath,
    requireKey: true,
    rationale: `agent ${cfg.agentId} runtime reply`,
  });
  sendMessage(to, signed, cfg.agentId);
}

/**
 * The completion boundary. Call this ONLY after the reply has been persisted
 * AND any auto-commit has finished — acking earlier deletes the `cur/` record
 * that the auto-commit scope guard reads (cli#380 defect 7), and NOT acking
 * leaves the record to be re-presented (and the task re-run) every lease period
 * forever.
 *
 * Acking removes the `cur/` record; nothing records the ack itself (the
 * mailbox archive has no ack event and does not bind a row to the record's
 * verification verdict or envelopeId), so re-presentation — not an audit trail
 * — is what ack prevents.
 */
export function completeRuntimeMail(cfg: RuntimeMailConfig, id: string): void {
  const acked = ackMessage(cfg.agentId, id);
  if (!acked) {
    swarn(`[${cfg.agentId}] ack found no record for ${id} (already acked/archived?)`);
  }
}

/**
 * Boot preflight: one Flair check, LOUD on failure.
 *
 * Reachability is necessary but not sufficient (bad credentials against a
 * healthy Flair produce a TERMINAL verification rejection), so this is a
 * preflight, not a proof — the first real message is the proof.
 */
export async function runtimeBootPreflight(
  flair: { ping(): Promise<boolean> },
  agentId: string,
): Promise<boolean> {
  const online = await flair.ping();
  if (online) {
    slog(`[${agentId}] Flair preflight OK`);
  } else {
    swarn(
      `[${agentId}] ⚠️  Flair preflight FAILED — the mailbox cannot verify mail; ` +
        `this runtime will IDLE rather than act on unverified input until Flair returns.`,
    );
  }
  return online;
}
