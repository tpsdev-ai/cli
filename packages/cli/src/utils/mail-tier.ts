import { signedTrustTier, type Envelope } from "@tpsdev-ai/agent";

export function externalDispatchRefusal(
  envelope: Envelope | undefined,
  from: string,
  tier?: string,
): string | null {
  const trust = envelope?.trust;
  if (tier === undefined && trust === undefined) return null;
  if ((tier ?? signedTrustTier(trust)) !== "external") return null;
  return `external-tier mail from ${from} is not dispatched with the internal capability set (signed trust ${JSON.stringify(trust)})`;
}
