import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { hashRaw, Algorithm } from "@node-rs/argon2";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface VaultData {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const key = await hashRaw(passphrase, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    outputLen: 32,
    salt,
  });
  return Buffer.from(key);
}

export async function encryptVault(data: unknown, passphrase: string): Promise<VaultData> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(data);
  let ciphertext = cipher.update(plaintext, "utf8", "base64");
  ciphertext += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  key.fill(0);

  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext,
  };
}

export async function decryptVault(vault: VaultData, passphrase: string): Promise<any> {
  const salt = Buffer.from(vault.salt, "base64");
  const iv = Buffer.from(vault.iv, "base64");
  const authTag = Buffer.from(vault.authTag, "base64");

  const key = await deriveKey(passphrase, salt);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(vault.ciphertext, "base64", "utf8");
  plaintext += decipher.final("utf8");

  key.fill(0);

  return JSON.parse(plaintext);
}

export function saveVault(path: string, vault: VaultData): void {
  writeFileSync(path, JSON.stringify(vault, null, 2), "utf-8");
}

export function loadVaultFile(path: string): VaultData | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}
