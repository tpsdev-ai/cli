/**
 * signing-key.ts — read an agent's Ed25519 private key as a 32-byte seed.
 *
 * `MailClient.sendMail` signs its body as a v1 envelope, so it needs the same
 * seed `@noble/ed25519` signs with. `@tpsdev-ai/agent` cannot import the CLI's
 * key reader (the dependency runs cli → agent), so this is the agent-side
 * reader for the formats a TPS identity key is stored in: a raw 32-byte seed,
 * one line of base64 PKCS8 DER, raw PKCS8 DER, or one PEM `PRIVATE KEY` block.
 *
 * Throws a named error when the file is absent — a sender with no key must
 * refuse rather than write an unsigned body a promote() reader dead-letters.
 */
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";

export function readSigningSeedFile(keyPath: string): Uint8Array {
  if (!existsSync(keyPath)) {
    throw new Error(
      `no Ed25519 private key at ${keyPath} — refusing to send unsigned mail. ` +
        `Provision the agent's key (tps agent create), or set flair.keyPath.`,
    );
  }

  let raw: Buffer;
  try {
    raw = readFileSync(keyPath);
  } catch (err) {
    throw new Error(`cannot read the Ed25519 private key at ${keyPath}: ${(err as Error).message}`);
  }

  // A raw 32-byte seed is the key itself.
  if (raw.length === 32) return new Uint8Array(raw);

  const text = raw.toString("utf-8").trim();
  let der: Buffer;
  if (text.startsWith("-----")) {
    der = Buffer.from(text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  } else {
    der = Buffer.from(text, "base64");
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error(`the file at ${keyPath} is not a usable Ed25519 private key (PKCS8 DER or PEM expected)`);
  }
  const jwk = key.export({ format: "jwk" }) as { kty?: string; d?: string };
  if (jwk.kty !== "OKP" || !jwk.d) {
    throw new Error(`the key at ${keyPath} is not an Ed25519 private key`);
  }
  return new Uint8Array(Buffer.from(jwk.d, "base64url"));
}
