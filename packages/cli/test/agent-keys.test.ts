import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { toEd25519Seed, readAgentPrivateKey } from "../src/utils/agent-keys.js";

// Wire sync sha512 so @noble sign/verify run synchronously (same as signEnvelope.ts).
hashes.sha512 = (m: Uint8Array) => new Uint8Array(createHash("sha512").update(m).digest());

/** Mint an Ed25519 keypair and expose every on-disk representation we care about. */
function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer; // 48-byte PKCS8 DER
  const b64Pkcs8 = der.toString("base64"); // 64-char base64 — how kern/sherlock/anvil/pulse are stored
  const seed = Buffer.from((privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url"); // raw 32-byte seed
  const pub = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"); // raw 32-byte pubkey
  return { der, b64Pkcs8, seed, pub };
}

describe("toEd25519Seed", () => {
  test("passes a raw 32-byte seed through unchanged (flint's format)", () => {
    const { seed } = makeKey();
    expect(toEd25519Seed(Buffer.from(seed)).equals(seed)).toBe(true);
  });

  test("decodes base64-PKCS8 to the 32-byte seed (the broken-before format)", () => {
    const { b64Pkcs8, seed } = makeKey();
    const out = toEd25519Seed(Buffer.from(b64Pkcs8, "utf8"));
    expect(out.length).toBe(32);
    expect(out.equals(seed)).toBe(true);
  });

  test("decodes raw PKCS8 DER bytes to the 32-byte seed", () => {
    const { der, seed } = makeKey();
    expect(toEd25519Seed(der).equals(seed)).toBe(true);
  });

  test("the normalized seed signs a payload verifiable by the original pubkey", () => {
    const { b64Pkcs8, pub } = makeKey();
    const seed = toEd25519Seed(Buffer.from(b64Pkcs8, "utf8"));
    const msg = new TextEncoder().encode("tps-mail envelope");
    const sig = ed.sign(msg, seed);
    expect(ed.verify(sig, msg, pub)).toBe(true); // would have failed with the un-normalized 64-byte key
  });

  test("throws on an unrecognized key format", () => {
    expect(() => toEd25519Seed(Buffer.from([1, 2, 3, 4]))).toThrow(/Unrecognized/);
  });
});

describe("readAgentPrivateKey", () => {
  function withKeysDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "tps-keys-"));
    const prev = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = dir;
    try {
      return fn(dir);
    } finally {
      if (prev === undefined) delete process.env.TPS_TEST_KEYS_DIR;
      else process.env.TPS_TEST_KEYS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("reads + normalizes a base64-PKCS8 key file", () => {
    const { b64Pkcs8, seed } = makeKey();
    withKeysDir((dir) => {
      writeFileSync(join(dir, "kerntest.key"), b64Pkcs8, { mode: 0o600 });
      const out = readAgentPrivateKey("kerntest");
      expect(out).not.toBeNull();
      expect(out!.length).toBe(32);
      expect(out!.equals(seed)).toBe(true);
    });
  });

  test("reads a raw-seed key file unchanged", () => {
    const { seed } = makeKey();
    withKeysDir((dir) => {
      writeFileSync(join(dir, "flinttest.key"), seed, { mode: 0o600 });
      const out = readAgentPrivateKey("flinttest");
      expect(out!.equals(seed)).toBe(true);
    });
  });

  test("returns null for a missing key", () => {
    withKeysDir(() => {
      expect(readAgentPrivateKey("nope")).toBeNull();
    });
  });
});
