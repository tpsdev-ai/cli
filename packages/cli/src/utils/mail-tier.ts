/**
 * mail-tier.ts — the CONSUMER-side tier gate (cli#433 slice B2-1).
 *
 * A consumer that launches work from verified mail reads the SIGNED tier and
 * must not give `external` mail the internal capability set. The tier decision
 * itself is the ONE mapping — `signedTrustTier` from `@tpsdev-ai/agent`, the
 * same function the runtime event loop applies (#466) — so there is no second
 * mapping here.
 *
 * A record with NO signed claim is the sender's pre-existing default and is
 * left to the consumer unchanged: an unsigned-by-tier body reaches a consumer
 * only after `promote()` verified its signature, and this gate only refuses a
 * tier the sender explicitly claimed. Every producer in the CLI signs mail
 * WITHOUT a trust claim, so current traffic is unchanged; the channel bridge is
 * the first producer to sign an explicit tier (external), in slice B2-2.
 */

import { signedTrustTier, type Envelope } from "@tpsdev-ai/agent";

/**
 * Refuse to dispatch a verified record whose SIGNED tier is external (or a
 * signed `user`, which never grants operator tools). Returns the named reason,
 * or null when the record carries no signed claim and dispatch proceeds as
 * before.
 */
export function externalDispatchRefusal(
  envelope: Envelope | undefined,
  from: string,
): string | null {
  const trust = envelope?.trust;
  if (trust === undefined) return null;
  if (signedTrustTier(trust) !== "external") return null;
  return `external-tier mail from ${from} is not dispatched with the internal capability set (signed trust ${JSON.stringify(trust)})`;
}
