/**
 * envelope-id.ts — the ONE shape rule for a signed envelope's ids (cli#429).
 *
 * A v1 envelope's `messageId` is the durable id of a message (it survives every
 * hop; the local record `id` does not), and `replyToId` threads a reply to the
 * `messageId` it answers. Both are the same kind of value, so both are held to
 * the same rule, on BOTH sides:
 *
 *   - SEND: `tps mail send --reply-to` and every signer that sets `replyToId`
 *     (mail-sign.ts, the openclaw-tps-mail plugin) refuse an id outside it, so
 *     no caller can put a blob, whitespace or a control character into the
 *     signed envelope.
 *   - RECEIPT: the shared mailbox policy (mail.ts `decideEnvelopeForMailbox`,
 *     run by first delivery AND by every re-presentation) dead-letters an
 *     envelope whose `messageId`, or `replyToId` when present, is outside it —
 *     so a verified record can never present such a value, whoever signed it.
 *
 * The rule: 1-128 characters from letters, digits, dot, underscore and hyphen.
 * It admits the UUIDs every signer in this repo generates (randomUUID) and the
 * dotted/hyphenated ids the fleet also uses.
 */

/** 1-128 chars of `[A-Za-z0-9._-]`. Anchored; no flags. */
export const ENVELOPE_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** A human-readable statement of ENVELOPE_ID_SHAPE, for error messages. */
export const ENVELOPE_ID_SHAPE_TEXT = "letters, digits, dot, underscore or hyphen, 1-128 chars";

/** True only for a string that satisfies ENVELOPE_ID_SHAPE. */
export function isValidEnvelopeId(id: unknown): id is string {
  return typeof id === "string" && ENVELOPE_ID_SHAPE.test(id);
}
