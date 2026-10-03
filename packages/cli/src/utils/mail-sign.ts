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
 * Both callers set `requireKey` (cli#429): a send that cannot sign FAILS before
 * anything is written. `tps mail send` resolves the key by agent id
 * (agent-keys.ts: ~/.flair/keys/<id>.key and ~/.tps/identity/<id>.key; two
 * files holding different keys are refused); the agent runtimes pass their
 * configured `flairKeyPath`. Every refusal names the path(s) it looked at and
 * the remedy.
 */

import { randomUUID } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry, type TrustLevel } from "@tpsdev-ai/agent";
import { readAgentPrivateKey, agentKeyCandidates, AgentKeyError, AgentKeyConflictError } from "./agent-keys.js";
import { isValidEnvelopeId, ENVELOPE_ID_SHAPE_TEXT } from "./envelope-id.js";

/**
 * Throws a named error if `id` is not a valid signed-envelope messageId — the
 * ONE shape rule (envelope-id.ts) the receipt side also enforces, so a reply-to
 * the sender accepts is one the recipient accepts. Exported so the CLI can
 * validate before it builds (and so a test can target the validator directly).
 */
export function assertValidReplyToId(id: string): void {
  if (!isValidEnvelopeId(id)) {
    throw new Error(
      `invalid --reply-to id: must be the signed messageId of the message being replied to ` +
        `(${ENVELOPE_ID_SHAPE_TEXT})`,
    );
  }
}

/**
 * The refusal for a key that EXISTS but cannot be used: names the path and the
 * remedy. The AgentKeyError text never carries key material.
 */
function unusableKeyError(from: string, err: AgentKeyError): Error {
  const remedy =
    err.kind === "unreadable"
      ? `make ${err.path} readable by this user (mode 0600, owned by this user)`
      : `replace ${err.path} with a valid unencrypted Ed25519 private key: a raw 32-byte seed, ` +
        `one line of base64 PKCS8 DER, raw PKCS8 DER, or exactly one PEM "PRIVATE KEY" block`;
  return new Error(`cannot sign for agent "${from}": ${err.message}. Remedy: ${remedy}.`);
}

export interface SignOutboundOptions {
  /** Explicit Ed25519 key path, checked against both default locations (or TPS_TEST_KEYS_DIR). */
  keyPath?: string;
  /** Prior delegation chain to extend. Null/undefined originates a fresh one. */
  priorChain?: ChainEntry[] | null;
  /** Rationale recorded for this agent hop. */
  rationale?: string;
  /** Envelope subject. */
  subject?: string;
  /**
   * The SIGNED trust tier for this envelope. cli#433 slice B2-2: the channel
   * bridge signs its inbound messages as `external`. Setting it here puts the
   * value inside the signed envelope, so a receiver verifies it; an absent
   * value leaves the envelope without a claim (unchanged caller behaviour).
   */
  trust?: TrustLevel;
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
  // cli#429: validate the thread id BEFORE any key is read, so an invalid
  // --reply-to is refused the same way with or without a key.
  if (opts.replyToId !== undefined) assertValidReplyToId(opts.replyToId);

  let privkey: Buffer | null;
  try {
    privkey = readAgentPrivateKey(from, opts.keyPath);
  } catch (err) {
    if (err instanceof AgentKeyError) throw unusableKeyError(from, err);
    if (err instanceof AgentKeyConflictError) throw new Error(`cannot sign for agent "${from}": ${err.message}`);
    throw err;
  }

  if (!privkey) {
    if (opts.requireKey) {
      const searched = opts.keyPath ? [opts.keyPath] : agentKeyCandidates(from);
      throw new Error(
        `no Ed25519 private key for agent "${from}" — refusing to send an unsigned body: ` +
          `a promote()-reading recipient dead-letters it terminal. Looked at ${searched.join(", then ")}. ` +
          `Provision the key: install the agent's Ed25519 private key at ${searched[0]} ` +
          `(or set TPS_TEST_KEYS_DIR in tests).`,
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

  // cli#433 B2-2: the trust tier, when asked for, is a top-level envelope field,
  // so JCS canonicalization covers it with the signature exactly like `body`:
  // a receiver that flips the tier invalidates the outer signature.
  if (opts.trust !== undefined) envelope.trust = opts.trust;

  // cli#429: thread the reply. Validated above, before any key was read, and
  // only set when present, so an absent --reply-to produces byte-for-byte the
  // same envelope (and signature) as before. Set as a top-level field: JCS
  // canonicalization in signEnvelope() then covers it with the signature.
  if (opts.replyToId !== undefined) envelope.replyToId = opts.replyToId;

  return JSON.stringify(signEnvelope(envelope, { [from]: privkey }));
}
