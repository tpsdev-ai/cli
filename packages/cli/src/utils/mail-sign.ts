/**
 * mail-sign.ts — the ONE outbound signing path.
 *
 * Since cli#377 a `promote()`-reading recipient verifies every body as a v1
 * signed envelope and DEAD-LETTERS a plain/unsigned body terminal (a parse
 * failure is `invalid`, not the retryable `verify-unavailable`). An unsigned
 * reply is therefore a dead letterbox: the recipient never presents it and
 * never heals. This module is shared by `tps mail send` and the agent runtimes
 * so the envelope shape cannot drift between the two.
 *
 * Two callers, two policies, one implementation:
 *   - `tps mail send` keeps the historical unsigned FALLBACK (warn + ship the
 *     raw body) so an operator with no key is not blocked, but it now resolves
 *     through the same builder.
 *   - the agent runtimes set `requireKey` and pass their configured
 *     `flairKeyPath`: a runtime that cannot sign must fail LOUDLY (it cannot
 *     deliver a usable reply anyway) instead of shipping a dead letter.
 */

import { randomUUID } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";
import { readAgentPrivateKey, readPrivateKeyAtPath, agentKeyPath } from "./agent-keys.js";

/**
 * Allowed shape for a `--reply-to` id (cli#429). A signed envelope's
 * `messageId` is a UUID; this accepts that and the dotted/hyphenated ids the
 * fleet also uses, while rejecting empty strings, whitespace and control
 * characters. Bounded so a caller cannot smuggle a blob into the signed
 * envelope through the flag.
 */
const REPLY_TO_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Throws a named error if `id` is not a plausible signed-envelope messageId.
 * Exported so the CLI can validate before it builds (and so a test can target
 * the validator directly).
 */
export function assertValidReplyToId(id: string): void {
  if (!REPLY_TO_ID.test(id)) {
    throw new Error(
      `invalid --reply-to id: must be the signed messageId of the message being replied to ` +
        `(letters, digits, dot, underscore or hyphen, 1-128 chars)`,
    );
  }
}

export interface SignOutboundOptions {
  /** Explicit Ed25519 key path. Falls back to ~/.flair/keys/<from>.key (or TPS_TEST_KEYS_DIR). */
  keyPath?: string;
  /** Prior delegation chain to extend. Null/undefined originates a fresh one. */
  priorChain?: ChainEntry[] | null;
  /** Rationale recorded for this agent hop. */
  rationale?: string;
  /** Envelope subject. */
  subject?: string;
  /** Override the generated messageId (tests). */
  messageId?: string;
  /**
   * cli#429: the signed `messageId` this body replies to. Carried INSIDE the
   * envelope (so it is covered by the signature and cannot be altered in
   * transit); surfaced on receipt. Validated here so no caller can widen it.
   */
  replyToId?: string;
  /** When true, throw if no key is available instead of returning the raw body. */
  requireKey?: boolean;
}

/**
 * Sign an outbound body as a v1 envelope — the one shape `promote()` accepts.
 * Returns the JSON-stringified signed envelope (or the raw body when unsigned
 * and `requireKey` is false; throws when unsigned and `requireKey` is true).
 */
export function signOutboundBody(
  from: string,
  to: string,
  body: string,
  opts: SignOutboundOptions = {},
): string {
  const privkey = opts.keyPath
    ? readPrivateKeyAtPath(opts.keyPath)
    : readAgentPrivateKey(from);

  if (!privkey) {
    if (opts.requireKey) {
      const where = opts.keyPath ? `Looked at ${opts.keyPath}.` : `Looked at ${agentKeyPath(from)}.`;
      throw new Error(
        `no Ed25519 private key for agent "${from}" — refusing to send an unsigned body: ` +
          `a promote()-reading recipient dead-letters it terminal. ${where} ` +
          `Provision the key (or set TPS_TEST_KEYS_DIR in tests).`,
      );
    }
    return body;
  }

  const now = new Date().toISOString();
  // Shallow-copy the caller's chain before extending it. `opts.priorChain` is the
  // CALLER's array and `chain.push(...)` below must not append to it (it aliased
  // caller state — no current caller is affected, but it is still wrong).
  const chain: ChainEntry[] = [
    ...(opts.priorChain ?? [
      {
        agent: "system",
        kind: "human" as const,
        timestamp: now,
        rationale: "tps mail send (no inbound chain)",
        signature: null,
      },
    ]),
  ];
  chain.push({
    agent: from,
    kind: "agent" as const,
    timestamp: now,
    rationale: opts.rationale ?? `agent ${from} tps mail send`,
    signature: null, // signEnvelope fills it
  });

  const envelope: Envelope = {
    v: 1,
    from,
    to,
    subject: opts.subject ?? `mail to ${to}`,
    body,
    messageId: opts.messageId ?? randomUUID(),
    timestamp: now,
    delegationChain: chain,
  };

  // cli#429: thread the reply. Validated BEFORE the envelope is built, and only
  // set when present, so an absent --reply-to produces byte-for-byte the same
  // envelope (and signature) as before. Set as a top-level field: JCS
  // canonicalization in signEnvelope() then covers it with the signature.
  if (opts.replyToId !== undefined) {
    assertValidReplyToId(opts.replyToId);
    envelope.replyToId = opts.replyToId;
  }

  return JSON.stringify(signEnvelope(envelope, { [from]: privkey }));
}
