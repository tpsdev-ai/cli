/**
 * A branch-side peer for the close-grace case in `mail-send-unconfirmed.test.ts`.
 *
 * It is the REAL Noise IK listener (`listenForHost`): it completes the handshake
 * and prints its port and public keys, then FREEZES the whole process the moment
 * the deliver arrives, so it neither ACKs nor answers the close. A frozen
 * process is the one way to keep a peer's socket open after the sender ends its
 * side: otherwise the kernel answers the FIN (or the peer's runtime answers the
 * close) at once and the sender's close grace is never spent.
 *
 * The sender's host public key is passed in `TPS_TEST_PEER_HOST_PUBKEY`
 * (base64url; a public key, never a secret).
 */
import { generateKeyPair } from "../../src/utils/identity.js";
import { listenForHost } from "../../src/utils/noise-ik-transport.js";
import { MSG_MAIL_DELIVER } from "../../src/utils/wire-mail.js";

const branchKp = generateKeyPair();
const hostPubkey = Buffer.from(process.env.TPS_TEST_PEER_HOST_PUBKEY ?? "", "base64url");

const server = await listenForHost(branchKp, new Uint8Array(hostPubkey), 0, (msg) => {
  if (msg.type !== MSG_MAIL_DELIVER) return;
  process.kill(process.pid, "SIGSTOP");
});

process.stdout.write(
  `${JSON.stringify({
    port: server.port?.() ?? 0,
    signingKey: Buffer.from(branchKp.signing.publicKey).toString("base64url"),
    encryptionKey: Buffer.from(branchKp.encryption.publicKey).toString("base64url"),
  })}\n`,
);
