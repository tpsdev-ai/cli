/**
 * A branch-side peer for the close-grace case in `mail-send-unconfirmed.test.ts`.
 *
 * It is the REAL Noise IK listener (`listenForHost`): it completes the handshake
 * and prints its port and public keys, then FREEZES the whole process the moment
 * the deliver arrives, so it neither ACKs nor answers the close. Whether that
 * keeps the socket open depends on the runtime's own teardown: where the close
 * waits for the peer's FIN, a frozen peer is what makes the sender spend its
 * close grace.
 *
 * Before stopping it writes `frozen` as its own stdout line, synchronously, so
 * the test can assert that the freeze happened instead of inferring it from the
 * delivery's elapsed time (a missed premise then fails by name, not as a timing
 * number).
 *
 * The sender's host public key is passed in `TPS_TEST_PEER_HOST_PUBKEY`
 * (base64url; a public key, never a secret).
 */
import { writeSync } from "node:fs";
import { generateKeyPair } from "../../src/utils/identity.js";
import { listenForHost } from "../../src/utils/noise-ik-transport.js";
import { MSG_MAIL_DELIVER } from "../../src/utils/wire-mail.js";

const branchKp = generateKeyPair();
const hostPubkey = Buffer.from(process.env.TPS_TEST_PEER_HOST_PUBKEY ?? "", "base64url");

const server = await listenForHost(branchKp, new Uint8Array(hostPubkey), 0, (msg) => {
  if (msg.type !== MSG_MAIL_DELIVER) return;
  writeSync(1, "frozen\n");
  process.kill(process.pid, "SIGSTOP");
});

process.stdout.write(
  `${JSON.stringify({
    port: server.port?.() ?? 0,
    signingKey: Buffer.from(branchKp.signing.publicKey).toString("base64url"),
    encryptionKey: Buffer.from(branchKp.encryption.publicKey).toString("base64url"),
  })}\n`,
);
