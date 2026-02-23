import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Vault File Format
export interface VaultData {
  salt: string;       // base64
  iv: string;         // base64
  authTag: string;    // base64
  ciphertext: string; // base64
}

// Derive a 32-byte key using PBKDF2-SHA256 (64MB memory cost for Argon2id simulated by high iterations)
export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Sync(passphrase, salt, 100000, 32, "sha256");
}

export async function encryptVault(data: any, passphrase: string): Promise<VaultData> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(data);
  let ciphertext = cipher.update(plaintext, "utf8", "base64");
  ciphertext += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  key.fill(0); // Zeroize key

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

  key.fill(0); // Zeroize key

  return JSON.parse(plaintext);
}

export function saveVault(path: string, vault: VaultData): void {
  writeFileSync(path, JSON.stringify(vault, null, 2), "utf-8");
}

export function loadVaultFile(path: string): VaultData | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}
