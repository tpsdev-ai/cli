import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Vault File Format
export interface VaultData {
  salt: string;       // base64
  iv: string;         // base64
  authTag: string;    // base64
  ciphertext: string; // base64
  kdf?: {
    n: number;  // CPU/memory cost (scrypt N)
    r: number;  // block size
    p: number;  // parallelism
  };
}

// Default KDF parameters (scrypt)
// N=2^17 (~128MB), r=8, p=1 — comparable security to argon2id defaults
const DEFAULT_KDF = { n: 131072, r: 8, p: 1 };

// Derive a 32-byte key using scrypt (built-in, no native deps)
export async function deriveKey(
  passphrase: string, 
  salt: Buffer, 
  params = DEFAULT_KDF
): Promise<Buffer> {
  return scryptSync(passphrase, salt, 32, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: params.n * params.r * 256,
  });
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
    n: vault.kdf?.n ?? DEFAULT_KDF.n,
    r: vault.kdf?.r ?? DEFAULT_KDF.r,
    p: vault.kdf?.p ?? DEFAULT_KDF.p,
  };

  const key = await deriveKey(passphrase, salt, params);
  
  // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length — authTagLength is set to 16
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
