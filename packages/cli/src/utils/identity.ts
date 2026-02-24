/**
 * TPS Identity Primitives — Ed25519 signing + X25519 encryption.
 *
 * Every entity (host or branch) has TWO keypairs derived from one 32-byte seed:
 *   - Ed25519 for signing/verification (identity proof)
 *   - X25519 for encryption/key exchange (secret delivery, Noise handshake)
 *
 * The private key IS the identity. Lose it → revoke and re-provision.
 * Branch generates its own keys — the host NEVER sees a branch's private key.
 */
import * as ed from "@noble/ed25519";
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { encryptVault, decryptVault, saveVault, loadVaultFile } from "./vault.js";

// --- Vaulted Storage (ops-24.1) ---

export interface TpsVault {
  identity: {
    seed: string; // base64
    createdAt: string;
    expiresAt?: string;
  };
  secrets: Record<string, string>;
}

function vaultPath(): string {
  return join(getIdentityDir(), "vault.json");
}

function getVaultPassphrase(): string {
  const key = process.env.TPS_VAULT_KEY;
  if (!key) {
    console.error("❌ TPS_VAULT_KEY environment variable is required to unlock the identity vault.");
    process.exit(1);
  }
  return key;
}

export async function saveToVault(data: TpsVault): Promise<void> {
  const passphrase = getVaultPassphrase();
  const vaultData = await encryptVault(data, passphrase);
  saveVault(vaultPath(), vaultData);
}

export async function loadFromVault(): Promise<TpsVault | null> {
  const path = vaultPath();
  const vaultFile = loadVaultFile(path);
  if (!vaultFile) return null;

  const passphrase = getVaultPassphrase();
  try {
    return await decryptVault(vaultFile, passphrase);
  } catch (err) {
    throw new Error("Failed to decrypt vault. Check passphrase.");
  }
}

async function migrateToVault(): Promise<void> {
  const dir = getIdentityDir();
  const seedPath = join(dir, "host.seed");
  const metaPath = join(dir, "host.meta.json");

  if (existsSync(seedPath)) {
    const seed = new Uint8Array(readFileSync(seedPath));
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : {};
    
    const vault: TpsVault = {
      identity: {
        seed: Buffer.from(seed).toString("base64"),
        createdAt: meta.createdAt || new Date().toISOString(),
        expiresAt: meta.expiresAt,
      },
      secrets: {},
    };

    await saveToVault(vault);

    const filesToDelete = [
      "host.seed", "host.key", "host.pub",
      "host.x25519.key", "host.x25519.pub", "host.meta.json"
    ];
    for (const f of filesToDelete) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}


// noble/ed25519 v3 needs hashes.sha512 set for sync operations.
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

export interface TpsSigningKeyPair {
  publicKey: Uint8Array;   // 32 bytes Ed25519
  privateKey: Uint8Array;  // 32-byte seed
}

export interface TpsEncryptionKeyPair {
  publicKey: Uint8Array;   // 32 bytes X25519
  privateKey: Uint8Array;  // 32 bytes X25519
}

export interface TpsKeyPair {
  signing: TpsSigningKeyPair;
  encryption: TpsEncryptionKeyPair;
  seed: Uint8Array;        // 32-byte master seed (derives both keypairs)
  fingerprint: string;     // SHA-256 of signing public key
  createdAt: string;
  expiresAt?: string;

  // Backward compat — alias to signing keys
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface KeyMeta {
  fingerprint: string;
  createdAt: string;
  expiresAt?: string;
  trust?: "high" | "standard" | "low";
  revokedAt?: string;
  revokeReason?: string;
}

/**
 * Compute the fingerprint (SHA-256 hex) of a public key.
 */
export function fingerprint(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

/**
 * Derive X25519 private key from Ed25519 seed.
 * Uses SHA-512 of the seed (same as Ed25519 key expansion) and clamps
 * the first 32 bytes for Curve25519 scalar multiplication.
 * This is the same approach as libsodium's crypto_sign_ed25519_sk_to_curve25519.
 */
export function edSeedToX25519Private(seed: Uint8Array): Uint8Array {
  const h = createHash("sha512").update(seed).digest();
  const scalar = new Uint8Array(h.slice(0, 32));
  // Clamp for Curve25519
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

/**
 * Generate a new identity keypair (Ed25519 signing + X25519 encryption).
 * Both are derived from a single 32-byte seed.
 */
export function generateKeyPair(options?: {
  expiresIn?: number; // milliseconds
}): TpsKeyPair {
  const seed = new Uint8Array(randomBytes(32));

  // Ed25519 signing keypair
  const edPublic = ed.getPublicKey(seed);

  // X25519 encryption keypair (derived from same seed)
  const xPrivate = edSeedToX25519Private(seed);
  const xPublic = x25519.getPublicKey(xPrivate);

  const now = new Date();
  const fp = fingerprint(edPublic);

  return {
    signing: { publicKey: edPublic, privateKey: seed },
    encryption: { publicKey: xPublic, privateKey: xPrivate },
    seed,
    fingerprint: fp,
    createdAt: now.toISOString(),
    expiresAt: options?.expiresIn
      ? new Date(now.getTime() + options.expiresIn).toISOString()
      : undefined,
    // Backward compat
    publicKey: edPublic,
    privateKey: seed,
  };
}

/**
 * Sign a message with a private key.
 * Returns the 64-byte Ed25519 signature.
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed.sign(message, privateKey);
}

/**
 * Verify a signature against a message and public key.
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// --- Filesystem storage ---

function getIdentityDir(): string {
  return (
    process.env.TPS_IDENTITY_DIR ||
    join(process.env.HOME || homedir(), ".tps", "identity")
  );
}

function getRegistryDir(): string {
  return (
    process.env.TPS_REGISTRY_DIR ||
    join(process.env.HOME || homedir(), ".tps", "registry")
  );
}

/**
 * Save a keypair to a directory.
 * Private keys get 0600 permissions. Both Ed25519 and X25519 keys stored.
 */
export function saveKeyPair(
  keyPair: TpsKeyPair,
  dir: string,
  prefix: string = "host"
): void {
  mkdirSync(dir, { recursive: true });

  // Store the master seed (32 bytes — derives both keypairs)
  const seedPath = join(dir, `${prefix}.seed`);
  writeFileSync(seedPath, Buffer.from(keyPair.seed));
  chmodSync(seedPath, 0o600);

  // Ed25519 signing keys
  const keyPath = join(dir, `${prefix}.key`);
  const pubPath = join(dir, `${prefix}.pub`);
  writeFileSync(keyPath, Buffer.from(keyPair.signing.privateKey));
  chmodSync(keyPath, 0o600);
  writeFileSync(pubPath, Buffer.from(keyPair.signing.publicKey));

  // X25519 encryption keys
  const xKeyPath = join(dir, `${prefix}.x25519.key`);
  const xPubPath = join(dir, `${prefix}.x25519.pub`);
  writeFileSync(xKeyPath, Buffer.from(keyPair.encryption.privateKey));
  chmodSync(xKeyPath, 0o600);
  writeFileSync(xPubPath, Buffer.from(keyPair.encryption.publicKey));

  // Write metadata
  const meta: KeyMeta = {
    fingerprint: keyPair.fingerprint,
    createdAt: keyPair.createdAt,
    expiresAt: keyPair.expiresAt,
  };
  writeFileSync(join(dir, `${prefix}.meta.json`), JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Load a keypair from a directory.
 * Supports both new format (with seed + x25519) and legacy (ed25519 only).
 */
export function loadKeyPair(dir: string, prefix: string = "host"): TpsKeyPair {
  const keyPath = join(dir, `${prefix}.key`);
  const pubPath = join(dir, `${prefix}.pub`);
  const metaPath = join(dir, `${prefix}.meta.json`);
  const seedPath = join(dir, `${prefix}.seed`);

  if (!existsSync(keyPath) || !existsSync(pubPath)) {
    throw new Error(`No keypair found at ${dir}/${prefix}.*`);
  }

  const edPrivate = new Uint8Array(readFileSync(keyPath));
  const edPublic = new Uint8Array(readFileSync(pubPath));

  let meta: KeyMeta = {
    fingerprint: fingerprint(edPublic),
    createdAt: new Date().toISOString(),
  };
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  }

  // Load or derive X25519 keys
  const seed = existsSync(seedPath)
    ? new Uint8Array(readFileSync(seedPath))
    : edPrivate; // legacy: seed IS the ed25519 private key (32 bytes)

  const xPrivate = edSeedToX25519Private(seed);
  const xPubPath = join(dir, `${prefix}.x25519.pub`);
  const xPublic = existsSync(xPubPath)
    ? new Uint8Array(readFileSync(xPubPath))
    : x25519.getPublicKey(xPrivate);

  return {
    signing: { publicKey: edPublic, privateKey: edPrivate },
    encryption: { publicKey: xPublic, privateKey: xPrivate },
    seed,
    fingerprint: meta.fingerprint,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    publicKey: edPublic,
    privateKey: edPrivate,
  };
}

/**
 * Check if a private key file has safe permissions (0600).
 * Returns true if permissions are restrictive enough.
 */
export function checkKeyPermissions(keyPath: string): boolean {
  try {
    const st = statSync(keyPath);
    const mode = st.mode & 0o777;
    // Allow 0600 or 0400 (read-only)
    return mode === 0o600 || mode === 0o400;
  } catch {
    return false;
  }
}

// --- Host identity convenience ---

/**
 * Initialize host identity (generate keypair if not exists).
 * Returns the keypair (existing or newly generated).
 */
export async function initHostIdentity(options?: {
  expiresIn?: number;
  force?: boolean;
}): Promise<TpsKeyPair> {
  const dir = getIdentityDir();

  if (existsSync(join(dir, "host.seed")) && !options?.force) {
    await migrateToVault();
  }

  const existing = await loadFromVault();
  if (existing && !options?.force) {
    const seed = new Uint8Array(Buffer.from(existing.identity.seed, "base64"));
    return deriveFromSeed(seed, {
      createdAt: existing.identity.createdAt,
      expiresAt: existing.identity.expiresAt,
    });
  }

  const kp = generateKeyPair({ expiresIn: options?.expiresIn });
  const vault: TpsVault = {
    identity: {
      seed: Buffer.from(kp.seed).toString("base64"),
      createdAt: kp.createdAt,
      expiresAt: kp.expiresAt,
    },
    secrets: {},
  };
  await saveToVault(vault);
  return kp;
}

function deriveFromSeed(seed: Uint8Array, meta: any): TpsKeyPair {
  const edPublic = ed.getPublicKey(seed);
  const xPrivate = edSeedToX25519Private(seed);
  const xPublic = x25519.getPublicKey(xPrivate);

  return {
    signing: { publicKey: edPublic, privateKey: seed },
    encryption: { publicKey: xPublic, privateKey: xPrivate },
    seed,
    fingerprint: fingerprint(edPublic),
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    publicKey: edPublic,
    privateKey: seed,
  };
}

/**
 * Load the host identity. Throws if not initialized.
 */
export async function loadHostIdentity(): Promise<TpsKeyPair> {
  const vault = await loadFromVault();
  if (!vault) {
    if (existsSync(join(getIdentityDir(), "host.seed"))) {
      await migrateToVault();
      return loadHostIdentity();
    }
    throw new Error("No host identity found. Run `tps office init` first.");
  }
  return deriveFromSeed(new Uint8Array(Buffer.from(vault.identity.seed, "base64")), vault.identity);
}

export async function loadHostIdentityId(): Promise<string> {
  const safeHostname = () => hostname().split(".")[0]!;
  try {
    const vault = await loadFromVault();
    if (vault) {
      return safeHostname();
    }
  } catch {
    return safeHostname();
  }
  return safeHostname();
}


// --- Registry ---

export interface RegisteredKey {
  branchId: string;
  publicKey: Uint8Array;          // Ed25519 signing public key
  encryptionKey?: Uint8Array;     // X25519 encryption public key
  meta: KeyMeta;
}

/**
 * Register a branch's public keys in the host registry.
 * Branch generates its own keys — only PUBLIC keys are registered here.
 * The host NEVER sees a branch's private key.
 */
export function registerBranch(
  branchId: string,
  publicKey: Uint8Array,
  meta?: Partial<KeyMeta>,
  encryptionKey?: Uint8Array
): RegisteredKey {
  if (!/^[a-zA-Z0-9_-]+$/.test(branchId)) {
    throw new Error(
      `Invalid branch ID: "${branchId}". Use only letters, numbers, hyphens, underscores.`
    );
  }

  const dir = getRegistryDir();
  mkdirSync(dir, { recursive: true });

  const fp = fingerprint(publicKey);
  const fullMeta: KeyMeta = {
    fingerprint: fp,
    createdAt: meta?.createdAt || new Date().toISOString(),
    expiresAt: meta?.expiresAt,
    trust: meta?.trust || "standard",
  };

  // Ed25519 signing public key
  writeFileSync(join(dir, `${branchId}.pub`), Buffer.from(publicKey));

  // X25519 encryption public key (if provided)
  if (encryptionKey) {
    writeFileSync(join(dir, `${branchId}.x25519.pub`), Buffer.from(encryptionKey));
  }

  writeFileSync(
    join(dir, `${branchId}.meta.json`),
    JSON.stringify(fullMeta, null, 2),
    "utf-8"
  );

  return { branchId, publicKey, encryptionKey, meta: fullMeta };
}

/**
 * Look up a branch's registered key.
 */
export function lookupBranch(branchId: string): RegisteredKey | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(branchId)) return null;
  const dir = getRegistryDir();
  const pubPath = join(dir, `${branchId}.pub`);

  if (!existsSync(pubPath)) return null;

  // Check if revoked
  const revokedPath = join(dir, "revoked", `${branchId}.meta.json`);
  if (existsSync(revokedPath)) return null;

  const publicKey = new Uint8Array(readFileSync(pubPath));
  const metaPath = join(dir, `${branchId}.meta.json`);
  let meta: KeyMeta = {
    fingerprint: fingerprint(publicKey),
    createdAt: new Date().toISOString(),
  };
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  }

  // Load X25519 encryption public key if available
  const xPubPath = join(dir, `${branchId}.x25519.pub`);
  const encryptionKey = existsSync(xPubPath)
    ? new Uint8Array(readFileSync(xPubPath))
    : undefined;

  return { branchId, publicKey, encryptionKey, meta };
}

/**
 * Revoke a branch's key. Moves metadata to revoked/ directory.
 */
export function revokeBranch(branchId: string, reason: string): void {
  const dir = getRegistryDir();
  const pubPath = join(dir, `${branchId}.pub`);
  const metaPath = join(dir, `${branchId}.meta.json`);

  if (!existsSync(pubPath)) {
    throw new Error(`No registered key for branch: ${branchId}`);
  }

  const revokedDir = join(dir, "revoked");
  mkdirSync(revokedDir, { recursive: true });

  // Read existing meta, add revocation info
  let meta: KeyMeta = {
    fingerprint: "",
    createdAt: new Date().toISOString(),
  };
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  }
  meta.revokedAt = new Date().toISOString();
  meta.revokeReason = reason;

  // Move to revoked
  writeFileSync(
    join(revokedDir, `${branchId}.meta.json`),
    JSON.stringify(meta, null, 2),
    "utf-8"
  );

  // Remove from active registry
  try {
    unlinkSync(pubPath);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  } catch {
    // Best effort cleanup
  }
}

/**
 * Check if a branch key is revoked.
 */
export function isRevoked(branchId: string): boolean {
  const dir = getRegistryDir();
  return existsSync(join(dir, "revoked", `${branchId}.meta.json`));
}

/**
 * Check if a branch key is expired.
 */
export function isExpired(meta: KeyMeta): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt) < new Date();
}

/**
 * List all registered (non-revoked) branches.
 */
export function listBranches(): RegisteredKey[] {
  const dir = getRegistryDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir) as string[];

  return files
    .filter((f: string) => f.endsWith(".pub") && !f.includes(".x25519."))
    .map((f: string) => {
      const branchId = f.replace(/\.pub$/, "");
      return lookupBranch(branchId);
    })
    .filter((r: RegisteredKey | null): r is RegisteredKey => r !== null);
}
