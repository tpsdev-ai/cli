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
import { readAgentPrivateKey, readPrivateKeyAtPath } from "./agent-keys.js";

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
      const where = opts.keyPath ? `Looked at ${opts.keyPath}.` : `Looked for ~/.flair/keys/${from}.key.`;
      throw new Error(
        `no Ed25519 private key for agent "${from}" — refusing to send an unsigned body: ` +
          `a promote()-reading recipient dead-letters it terminal. ${where} ` +
          `Provision the key (or set TPS_TEST_KEYS_DIR in tests).`,
      );
    }
    return body;
  }

  const now = new Date().toISOString();
  const chain: ChainEntry[] = opts.priorChain ?? [
    {
      agent: "system",
      kind: "human" as const,
      timestamp: now,
      rationale: "tps mail send (no inbound chain)",
      signature: null,
    },
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

  return JSON.stringify(signEnvelope(envelope, { [from]: privkey }));
}
