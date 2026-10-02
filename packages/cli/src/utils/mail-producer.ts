/**
 * mail-producer.ts — the ONE signing path for CLI-internal mail producers.
 *
 * `tps mail send` signs every body it writes (utils/mail-sign.ts), so a
 * `promote()`-reading recipient verifies it. Several producers in this repo
 * wrote a body straight into a maildir instead, and a promote() reader
 * dead-letters an unsigned body terminal. This module is the one place those
 * producers sign: the same `signOutboundBody` builder, the same key resolution
 * and the same refusal as `tps mail send`. With no key it THROWS — naming the
 * path(s) it looked at and the remedy — before the delivery callback runs, so a
 * producer cannot write a record it cannot sign.
 */
import { signOutboundBody } from "./mail-sign.js";
import { sendMessage, type MailMessage } from "./mail.js";
import type { ChainEntry } from "@tpsdev-ai/agent";

export interface ProducerMailOptions {
  /** The signed `messageId` this body replies to. Carried inside the envelope. */
  replyToId?: string;
  /** Envelope subject. */
  subject?: string;
  /** Rationale recorded for this agent hop. */
  rationale?: string;
  /** Explicit Ed25519 key path, overriding the sender's default locations. */
  keyPath?: string;
  /** Prior delegation chain to extend. Null/undefined originates a fresh one. */
  priorChain?: ChainEntry[] | null;
}

/**
 * Sign `body` for agent `from` and hand the signed envelope to `deliver`. The
 * same key resolution `tps mail send` uses; with no key this throws before
 * `deliver` runs, so nothing is written.
 */
export function signForDelivery(
  from: string,
  to: string,
  body: string,
  deliver: (signedBody: string) => void,
  opts: ProducerMailOptions = {},
): void {
  const signed = signOutboundBody(from, to, body, { requireKey: true, ...opts });
  deliver(signed);
}

/**
 * Sign `body` for agent `from` and deliver it into `to`'s mailbox — the local
 * route of `tps mail send`. The record's `from` and `body` are the signed
 * envelope, so the recipient's `promote()` accepts it. Returns the written
 * record, as `sendMessage` does.
 */
export function sendSignedMail(
  from: string,
  to: string,
  body: string,
  opts: ProducerMailOptions = {},
): MailMessage & { filePath: string } {
  let sent!: MailMessage & { filePath: string };
  signForDelivery(
    from,
    to,
    body,
    (signed) => {
      sent = sendMessage(to, signed, from);
    },
    opts,
  );
  return sent;
}
