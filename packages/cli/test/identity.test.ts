import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

// Absolute path to the compiled CLI binary — resolves correctly regardless of cwd
const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
import {
  generateKeyPair,
  sign,
  verify,
  fingerprint,
  saveKeyPair,
  loadKeyPair,
  checkKeyPermissions,
  initHostIdentity,
  registerBranch,
  lookupBranch,
  revokeBranch,
  isRevoked,
  isExpired,
  listBranches,
  edSeedToX25519Private,
} from "../src/utils/identity.js";
import { x25519 } from "@noble/curves/ed25519.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tps-identity-test-"));
  process.env.TPS_VAULT_KEY = "test-passphrase";
  process.env.TPS_IDENTITY_DIR = join(tempDir, "identity");
  process.env.TPS_REGISTRY_DIR = join(tempDir, "registry");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TPS_VAULT_KEY;
  delete process.env.TPS_IDENTITY_DIR;
  delete process.env.TPS_REGISTRY_DIR;
});

describe("key generation", () => {
  test("generates valid keypair with signing and encryption keys", () => {
    const kp = generateKeyPair();
    // Signing (Ed25519)
    expect(kp.signing.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.signing.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.signing.publicKey.length).toBe(32);
    expect(kp.signing.privateKey.length).toBe(32);
    // Encryption (X25519)
    expect(kp.encryption.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.encryption.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.encryption.publicKey.length).toBe(32);
    expect(kp.encryption.privateKey.length).toBe(32);
    // Seed
    expect(kp.seed.length).toBe(32);
    // Backward compat
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("generates unique keypairs", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(kp1.fingerprint).not.toBe(kp2.fingerprint);
  });

  test("generates keypair with expiry", () => {
    const kp = generateKeyPair({ expiresIn: 90 * 86400000 });
    expect(kp.expiresAt).toBeTruthy();
    const expires = new Date(kp.expiresAt!);
    const now = new Date();
    const diffDays = (expires.getTime() - now.getTime()) / 86400000;
    expect(diffDays).toBeGreaterThan(89);
    expect(diffDays).toBeLessThan(91);
  });

  test("X25519 keypair supports DH key exchange", () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    // Both sides compute the same shared secret
    const sharedA = x25519.getSharedSecret(alice.encryption.privateKey, bob.encryption.publicKey);
    const sharedB = x25519.getSharedSecret(bob.encryption.privateKey, alice.encryption.publicKey);
    expect(Buffer.from(sharedA)).toEqual(Buffer.from(sharedB));
  });

  test("signing and encryption keys are different", () => {
    const kp = generateKeyPair();
    // Ed25519 and X25519 public keys should NOT be identical
    expect(Buffer.from(kp.signing.publicKey)).not.toEqual(Buffer.from(kp.encryption.publicKey));
  });
});

describe("signing and verification", () => {
  test("sign then verify roundtrip", () => {
    const kp = generateKeyPair();
    const message = new TextEncoder().encode("hello TPS");
    const sig = sign(message, kp.signing.privateKey);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(verify(message, sig, kp.signing.publicKey)).toBe(true);
  });

  test("verify fails with wrong key", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const message = new TextEncoder().encode("hello TPS");
    const sig = sign(message, kp1.signing.privateKey);
    expect(verify(message, sig, kp2.signing.publicKey)).toBe(false);
  });

  test("verify fails with tampered message", () => {
    const kp = generateKeyPair();
    const message = new TextEncoder().encode("hello TPS");
    const sig = sign(message, kp.signing.privateKey);
    const tampered = new TextEncoder().encode("hello TAMPERED");
    expect(verify(tampered, sig, kp.signing.publicKey)).toBe(false);
  });

  test("verify fails with tampered signature", () => {
    const kp = generateKeyPair();
    const message = new TextEncoder().encode("hello TPS");
    const sig = sign(message, kp.signing.privateKey);
    const badSig = new Uint8Array(sig);
    badSig[0] ^= 0xff;
    expect(verify(message, badSig, kp.signing.publicKey)).toBe(false);
  });
});

describe("fingerprint", () => {
  test("is deterministic for same key", () => {
    const kp = generateKeyPair();
    const fp1 = fingerprint(kp.publicKey);
    const fp2 = fingerprint(kp.publicKey);
    expect(fp1).toBe(fp2);
  });

  test("is different for different keys", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(fingerprint(kp1.publicKey)).not.toBe(fingerprint(kp2.publicKey));
  });
});

describe("key storage", () => {
  test("save and load roundtrip", () => {
    const kp = generateKeyPair({ expiresIn: 86400000 });
    const dir = join(tempDir, "keys");
    saveKeyPair(kp, dir, "test");

    const loaded = loadKeyPair(dir, "test");
    expect(loaded.fingerprint).toBe(kp.fingerprint);
    expect(loaded.createdAt).toBe(kp.createdAt);
    expect(loaded.expiresAt).toBe(kp.expiresAt);
    // Signing keys roundtrip
    expect(Buffer.from(loaded.signing.publicKey)).toEqual(Buffer.from(kp.signing.publicKey));
    expect(Buffer.from(loaded.signing.privateKey)).toEqual(Buffer.from(kp.signing.privateKey));
    // Encryption keys roundtrip
    expect(Buffer.from(loaded.encryption.publicKey)).toEqual(Buffer.from(kp.encryption.publicKey));
    expect(Buffer.from(loaded.encryption.privateKey)).toEqual(Buffer.from(kp.encryption.privateKey));

    // Verify loaded keys still work for signing
    const msg = new TextEncoder().encode("roundtrip test");
    const sig = sign(msg, loaded.signing.privateKey);
    expect(verify(msg, sig, loaded.signing.publicKey)).toBe(true);

    // Verify loaded keys still work for DH
    const other = generateKeyPair();
    const shared1 = x25519.getSharedSecret(loaded.encryption.privateKey, other.encryption.publicKey);
    const shared2 = x25519.getSharedSecret(other.encryption.privateKey, loaded.encryption.publicKey);
    expect(Buffer.from(shared1)).toEqual(Buffer.from(shared2));
  });

  test("private keys have 0600 permissions", () => {
    const kp = generateKeyPair();
    const dir = join(tempDir, "keys");
    saveKeyPair(kp, dir, "test");

    // Ed25519 signing key
    expect(checkKeyPermissions(join(dir, "test.key"))).toBe(true);
    expect(statSync(join(dir, "test.key")).mode & 0o777).toBe(0o600);
    // X25519 encryption key
    expect(checkKeyPermissions(join(dir, "test.x25519.key"))).toBe(true);
    expect(statSync(join(dir, "test.x25519.key")).mode & 0o777).toBe(0o600);
    // Seed
    expect(checkKeyPermissions(join(dir, "test.seed"))).toBe(true);
    expect(statSync(join(dir, "test.seed")).mode & 0o777).toBe(0o600);
  });

  test("load throws for missing keypair", () => {
    expect(() => loadKeyPair(join(tempDir, "nonexistent"), "test")).toThrow();
  });

  test("meta.json is written correctly", () => {
    const kp = generateKeyPair({ expiresIn: 86400000 });
    const dir = join(tempDir, "keys");
    saveKeyPair(kp, dir, "test");

    const meta = JSON.parse(readFileSync(join(dir, "test.meta.json"), "utf-8"));
    expect(meta.fingerprint).toBe(kp.fingerprint);
    expect(meta.createdAt).toBe(kp.createdAt);
    expect(meta.expiresAt).toBe(kp.expiresAt);
  });
});

describe("host identity", () => {
  test("init creates host keypair", async () => {
    const kp = await initHostIdentity();
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const identityDir = process.env.TPS_IDENTITY_DIR!;
    expect(existsSync(join(identityDir, "vault.json"))).toBe(true);
  });

  test("init returns existing keypair if already initialized", async () => {
    const kp1 = await initHostIdentity();
    const kp2 = await initHostIdentity();
    expect(kp1.fingerprint).toBe(kp2.fingerprint);
  });

  test("init with force regenerates keypair", async () => {
    const kp1 = await initHostIdentity();
    const kp2 = await initHostIdentity({ force: true });
    expect(kp1.fingerprint).not.toBe(kp2.fingerprint);
  });
});

describe("branch registry", () => {
  test("register and lookup with encryption key", () => {
    const kp = generateKeyPair();
    registerBranch("scraper", kp.signing.publicKey, { trust: "standard" }, kp.encryption.publicKey);

    const entry = lookupBranch("scraper");
    expect(entry).not.toBeNull();
    expect(entry!.branchId).toBe("scraper");
    expect(entry!.meta.fingerprint).toBe(kp.fingerprint);
    expect(entry!.meta.trust).toBe("standard");
    expect(entry!.encryptionKey).toBeTruthy();
    expect(Buffer.from(entry!.encryptionKey!)).toEqual(Buffer.from(kp.encryption.publicKey));
  });

  test("lookup returns null for unknown branch", () => {
    expect(lookupBranch("nonexistent")).toBeNull();
  });

  test("revoke removes branch from active registry", () => {
    const kp = generateKeyPair();
    registerBranch("rogue", kp.signing.publicKey);

    revokeBranch("rogue", "compromised");

    expect(lookupBranch("rogue")).toBeNull();
    expect(isRevoked("rogue")).toBe(true);

    // Revocation metadata preserved
    const revokedMeta = JSON.parse(
      readFileSync(
        join(process.env.TPS_REGISTRY_DIR!, "revoked", "rogue.meta.json"),
        "utf-8"
      )
    );
    expect(revokedMeta.revokedAt).toBeTruthy();
    expect(revokedMeta.revokeReason).toBe("compromised");
  });

  test("revoke throws for unknown branch", () => {
    expect(() => revokeBranch("ghost", "reasons")).toThrow(/No registered key/);
  });

  test("list returns all non-revoked branches", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const kp3 = generateKeyPair();

    registerBranch("alpha", kp1.signing.publicKey);
    registerBranch("beta", kp2.signing.publicKey);
    registerBranch("gamma", kp3.signing.publicKey);

    revokeBranch("beta", "test");

    const branches = listBranches();
    const ids = branches.map((b) => b.branchId).sort();
    expect(ids).toEqual(["alpha", "gamma"]);
  });

  test("rejects invalid branch IDs", () => {
    const kp = generateKeyPair();
    expect(() => registerBranch("../escape", kp.signing.publicKey)).toThrow(/Invalid branch ID/);
    expect(() => registerBranch("has spaces", kp.signing.publicKey)).toThrow(/Invalid branch ID/);
    expect(() => registerBranch("", kp.signing.publicKey)).toThrow(/Invalid branch ID/);
  });

  test("isExpired detects expired keys", () => {
    expect(isExpired({ fingerprint: "x", createdAt: "2026-01-01", expiresAt: "2020-01-01T00:00:00Z" })).toBe(true);
    expect(isExpired({ fingerprint: "x", createdAt: "2026-01-01", expiresAt: "2099-01-01T00:00:00Z" })).toBe(false);
    expect(isExpired({ fingerprint: "x", createdAt: "2026-01-01" })).toBe(false); // no expiry = never expires
  });
});

describe("CLI integration", () => {
  test("identity init shows signing and encryption keys via CLI", () => {
    const { execSync } = require("node:child_process");
    const result = execSync(
      `bun ${TPS_BIN} identity init --json --nonono`,
      {
        encoding: "utf-8",
        env: { ...process.env, TPS_VAULT_KEY: "test-passphrase", TPS_IDENTITY_DIR: join(tempDir, "cli-identity"), TPS_REGISTRY_DIR: join(tempDir, "cli-registry") },
      }
    );
    const parsed = JSON.parse(result);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.signingPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.signingPublicKey).not.toBe(parsed.encryptionPublicKey);
  });

  test("identity register (from branch pubkey) + list + verify + revoke via CLI", () => {
    const { execSync } = require("node:child_process");
    const env = {
      ...process.env,
      TPS_IDENTITY_DIR: join(tempDir, "cli-identity-2"),
      TPS_REGISTRY_DIR: join(tempDir, "cli-registry-2"),
    };

    // Simulate: branch generates keys
    const branchKp = generateKeyPair();
    const sigHex = Buffer.from(branchKp.signing.publicKey).toString("hex");
    const encHex = Buffer.from(branchKp.encryption.publicKey).toString("hex");

    // Host registers branch's PUBLIC keys (never sees private keys)
    const regResult = execSync(
      `bun ${TPS_BIN} identity register test-branch --pubkey ${sigHex} --enc-pubkey ${encHex} --json --expires-in 90d --nonono`,
      { encoding: "utf-8", env }
    );
    const reg = JSON.parse(regResult);
    expect(reg.branchId).toBe("test-branch");
    expect(reg.fingerprint).toBe(branchKp.fingerprint);
    expect(reg.hasEncryptionKey).toBe(true);

    // List
    const listResult = execSync(
      `bun ${TPS_BIN} identity list --json --nonono`,
      { encoding: "utf-8", env }
    );
    const list = JSON.parse(listResult);
    expect(list.length).toBe(1);
    expect(list[0].branchId).toBe("test-branch");

    // Verify
    const verifyResult = execSync(
      `bun ${TPS_BIN} identity verify test-branch --json --nonono`,
      { encoding: "utf-8", env }
    );
    const ver = JSON.parse(verifyResult);
    expect(ver.valid).toBe(true);

    // Revoke
    execSync(
      `bun ${TPS_BIN} identity revoke test-branch --reason "test revocation" --nonono`,
      { env }
    );

    // Verify after revoke should fail
    try {
      execSync(
        `bun ${TPS_BIN} identity verify test-branch --json --nonono`,
        { encoding: "utf-8", env }
      );
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(1);
    }
  });
});
