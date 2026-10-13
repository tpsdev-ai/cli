/**
 * signed-relay-record.ts — a relayed mail record carrying a validly signed
 * envelope, and a Flair stub that resolves the sender's public key, which
 * MailClient uses to verify it, for MailClient promotion tests.
 */
import * as ed from "@noble/ed25519";
import { signEnvelope } from "../../src/lib/signEnvelope.js";

const SENDER_SEED = Buffer.alloc(32, 1);

/** A Flair stub that resolves the sender's public key, as MailClient needs to verify. */
export function senderKeyResolver() {
  return {
    async getAgent() {
      return { publicKey: Buffer.from(ed.getPublicKey(SENDER_SEED)) };
    },
  };
}

/** The raw bytes of a relayed record whose body is an envelope signed by `sender`, addressed to `to`. */
export function signedRelayRecord(to: string, messageId: string, relayDelivery: { branchId: string; id: string }): string {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope({
    v: 1, from: "sender", to, body: "hello", messageId, timestamp,
    delegationChain: [
      { agent: "system", kind: "human", timestamp, rationale: "origin", signature: null },
      { agent: "sender", kind: "agent", timestamp, rationale: "send", signature: null },
    ],
  }, { sender: SENDER_SEED });
  return JSON.stringify({ from: "sender", body: JSON.stringify(envelope), relayDelivery });
}
