import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { hashRaw, Algorithm } from "@node-rs/argon2";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Vault File Format
export interface VaultData {
  salt: string;       // base64
  iv: string;         // base64
  authTag: string;    // base64
  ciphertext: string; // base64
  kdf?: {
    m: number;
    t: number;
    p: number;
  };
}

// Default KDF parameters
const DEFAULT_KDF = { m: 65536, t: 3, p: 4 };

// Derive a 32-byte key using Argon2id
export async function deriveKey(
  passphrase: string, 
  salt: Buffer, 
  params = DEFAULT_KDF
): Promise<Buffer> {
  const key = await hashRaw(passphrase, {
    algorithm: Algorithm.Argon2id,
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
    outputLen: 32,
    salt,
  });
  return Buffer.from(key);
}

export async function encryptVault(data: any, passphrase: string): Promise<VaultData> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, DEFAULT_KDF);
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
    kdf: DEFAULT_KDF,
  };
}

export async function decryptVault(vault: VaultData, passphrase: string): Promise<any> {
  const salt = Buffer.from(vault.salt, "base64");
  const iv = Buffer.from(vault.iv, "base64");
  const authTag = Buffer.from(vault.authTag, "base64");
  
  const params = {
    m: vault.kdf?.m ?? DEFAULT_KDF.m,
    t: vault.kdf?.t ?? DEFAULT_KDF.t,
    p: vault.kdf?.p ?? DEFAULT_KDF.p,
  };

  const key = await deriveKey(passphrase, salt, params);
  
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  
  let plaintext = decipher.update(vault.ciphertext, "base64", "utf8");
  plaintext += decipher.final("utf8");

  key.fill(0); // Zeroize key

  return JSON.parse(plaintext);
}

export function saveVault(path: string, vault: VaultData): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(vault, null, 2), "utf-8");
}

export function loadVaultFile(path: string): VaultData | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}
