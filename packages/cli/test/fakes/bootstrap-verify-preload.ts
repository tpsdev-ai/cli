/** Stub only Flair key lookup in bootstrap's CLI child; promote() remains real. */
import { mock } from "bun:test";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { hashes } from "@noble/ed25519";
hashes.sha512 = (data) => new Uint8Array(createHash("sha512").update(data).digest());
const publicKey = Buffer.from(ed.getPublicKey(Buffer.alloc(32, 9)));
mock.module(new URL("../../dist/src/utils/mail-verify.js", import.meta.url).pathname, () => ({
  createMailVerifyClient: async () => ({
    getAgent: async (name: string) => name === "host" ? { publicKey } : null,
  }),
}));
