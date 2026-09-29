import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, createHash, createPrivateKey } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import {
  toEd25519Seed,
  readAgentPrivateKey,
  readPrivateKeyAtPath,
  resolveAgentKeyPath,
  agentKeyCandidates,
  AgentKeyError,
  AgentKeyConflictError,
  KeyFormatError,
} from "../src/utils/agent-keys.js";

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

// ─── cli#429 blocker 4: the loader is STRICT — one key, nothing else ─────────

describe("toEd25519Seed is strict (cli#429)", () => {
  function pemOf(der: Buffer): string {
    const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
    return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  }
  function jwkD(der: Buffer): Buffer {
    const d = createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "jwk" }).d as string;
    return Buffer.from(d, "base64url");
  }

  test("every accepted form yields EXACTLY node's JWK `d` (raw seed, base64 DER, raw DER, PEM)", () => {
    const { der, b64Pkcs8, seed } = makeKey();
    const d = jwkD(der);
    expect(d.equals(seed)).toBe(true);
    expect(toEd25519Seed(Buffer.from(seed)).equals(d)).toBe(true);
    expect(toEd25519Seed(Buffer.from(b64Pkcs8, "utf8")).equals(d)).toBe(true);
    expect(toEd25519Seed(Buffer.from(`${b64Pkcs8}\n`, "utf8")).equals(d)).toBe(true); // a trailing newline is whitespace
    expect(toEd25519Seed(der).equals(d)).toBe(true);
    expect(toEd25519Seed(Buffer.from(pemOf(der), "utf8")).equals(d)).toBe(true);
    // CRLF line endings are the same PEM.
    expect(toEd25519Seed(Buffer.from(pemOf(der).replace(/\n/g, "\r\n"), "utf8")).equals(d)).toBe(true);
  });

  /** Every rejection must be a KeyFormatError whose text carries no key material. */
  function expectRejected(input: Buffer, secretFragments: string[], pattern?: RegExp): void {
    let caught: unknown = null;
    try {
      toEd25519Seed(input);
    } catch (err) {
      caught = err;
    }
    expect(caught, "the input must be refused").toBeInstanceOf(KeyFormatError);
    const msg = (caught as Error).message;
    if (pattern) expect(msg).toMatch(pattern);
    for (const fragment of secretFragments) expect(msg.includes(fragment), "no key material in the error").toBe(false);
  }

  test("refuses TWO concatenated PEM keys (would have signed with the first)", () => {
    const a = makeKey();
    const b = makeKey();
    const both = pemOf(a.der) + pemOf(b.der);
    expectRejected(Buffer.from(both), [a.b64Pkcs8.slice(0, 40), b.b64Pkcs8.slice(0, 40)], /exactly one PEM block/);
  });

  test("refuses a PEM key with trailing or leading junk", () => {
    const k = makeKey();
    expectRejected(Buffer.from(`${pemOf(k.der)}EXTRA`), [k.b64Pkcs8.slice(0, 40), "EXTRA"]);
    expectRejected(Buffer.from(`junk\n${pemOf(k.der)}`), [k.b64Pkcs8.slice(0, 40), "junk"]);
  });

  test("refuses DER with trailing bytes, raw and base64 (complete DER consumption)", () => {
    const k = makeKey();
    const extra = Buffer.concat([k.der, Buffer.from("EXTRA")]);
    expectRejected(extra, [k.der.toString("hex").slice(0, 40)], /trailing or missing data/);
    expectRejected(Buffer.from(extra.toString("base64")), [k.b64Pkcs8.slice(0, 40)], /trailing or missing data/);
    // A truncated key is refused too.
    expectRejected(k.der.subarray(0, k.der.length - 1), [], /trailing or missing data|not a DER/);
  });

  test("refuses non-canonical base64 and a PEM body with headers or stray characters", () => {
    const k = makeKey();
    // A padded encoding whose PAD BITS are set: "AB==" decodes (leniently) to the
    // same byte as the canonical "AA==". The refusal must name canonicality —
    // not merely fail later on the DER length — so this pins the base64 check.
    const padded = Buffer.concat([k.der, Buffer.from([0x00])]).toString("base64");
    expect(padded.endsWith("AA==")).toBe(true);
    const noncanon = `${padded.slice(0, -4)}AB==`;
    expect(Buffer.from(noncanon, "base64").equals(Buffer.from(padded, "base64"))).toBe(true); // node is lenient
    expectRejected(Buffer.from(noncanon), [k.b64Pkcs8.slice(0, 40)], /not canonical base64/);
    const pemNoncanon = `-----BEGIN PRIVATE KEY-----\n${noncanon}\n-----END PRIVATE KEY-----\n`;
    expectRejected(Buffer.from(pemNoncanon), [k.b64Pkcs8.slice(0, 40)], /not canonical base64/);
    const withHeader = pemOf(k.der).replace("-----\n", "-----\nProc-Type: 4,ENCRYPTED\n");
    expectRejected(Buffer.from(withHeader), [k.b64Pkcs8.slice(0, 40)], /PEM headers are not supported/);
    const lines = pemOf(k.der).split("\n");
    lines[1] = `${lines[1]!.slice(0, 10)}*${lines[1]!.slice(11)}`;
    expectRejected(Buffer.from(lines.join("\n")), [k.b64Pkcs8.slice(0, 40)]);
  });

  test("refuses an ENCRYPTED PEM key by name", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const enc = privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "test-only" }).toString();
    expectRejected(Buffer.from(enc), [enc.split("\n")[1]!.slice(0, 40)], /ENCRYPTED/);
  });

  test("refuses an ENCRYPTED PKCS8 DER key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const enc = privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "test-only" }) as Buffer;
    expectRejected(enc, [enc.toString("hex").slice(0, 40)], /not a valid unencrypted PKCS8/);
    expectRejected(Buffer.from(enc.toString("base64")), [enc.toString("base64").slice(0, 40)], /not a valid unencrypted PKCS8/);
  });

  test("refuses other algorithms by name (X25519, EC P-256, RSA) in PEM and DER", () => {
    const x = generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    for (const der of [x, ec, rsa]) {
      expectRejected(der, [der.toString("hex").slice(0, 40)], /not an Ed25519 key/);
      expectRejected(Buffer.from(pemOf(der)), [der.toString("base64").slice(0, 40)], /not an Ed25519 key/);
    }
  });
});

// ─── cli#429 blocker 6: ONE key search path, stated precedence ──────────────

describe("agent key resolution precedence (cli#429)", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevTestKeys: string | undefined;

  function withHome<T>(fn: () => T): T {
    home = mkdtempSync(join(tmpdir(), "tps-keyres-"));
    prevHome = process.env.HOME;
    prevTestKeys = process.env.TPS_TEST_KEYS_DIR;
    process.env.HOME = home;
    delete process.env.TPS_TEST_KEYS_DIR;
    try {
      return fn();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevTestKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR;
      else process.env.TPS_TEST_KEYS_DIR = prevTestKeys;
      rmSync(home, { recursive: true, force: true });
    }
  }
  const flairKey = (id: string) => join(home, ".flair", "keys", `${id}.key`);
  const identityKey = (id: string) => join(home, ".tps", "identity", `${id}.key`);
  function put(path: string, content: Buffer | string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }

  test("the search path is ~/.flair/keys then ~/.tps/identity", () => {
    withHome(() => {
      expect(agentKeyCandidates("ember")).toEqual([flairKey("ember"), identityKey("ember")]);
    });
  });

  test("a key ONLY at ~/.tps/identity (tps init / agent create) is found", () => {
    // CONTROL: before cli#429 only ~/.flair/keys was consulted, so an agent
    // provisioned by `tps init` had no signing key at all.
    withHome(() => {
      const { seed } = makeKey();
      put(identityKey("ember"), seed);
      expect(resolveAgentKeyPath("ember")).toBe(identityKey("ember"));
      expect(readAgentPrivateKey("ember")!.equals(seed)).toBe(true);
    });
  });

  test("two DIFFERENT valid keys → refused, naming BOTH paths and the remedy — never one silently chosen", () => {
    // CONTROL: the previous head returned the ~/.flair/keys key silently, so a
    // stale Flair key signed mail its recipients verify against another key.
    withHome(() => {
      const flair = makeKey();
      const ident = makeKey();
      put(flairKey("kern"), flair.b64Pkcs8);
      put(identityKey("kern"), ident.seed);
      let caught: unknown = null;
      try {
        readAgentPrivateKey("kern");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentKeyConflictError);
      expect((caught as AgentKeyConflictError).paths).toEqual([flairKey("kern"), identityKey("kern")]);
      const msg = (caught as Error).message;
      expect(msg).toContain(flairKey("kern"));
      expect(msg).toContain(identityKey("kern"));
      expect(msg).toContain("Remedy:");
      // Never key material, in any of its forms.
      for (const k of [flair, ident]) {
        expect(msg).not.toContain(k.b64Pkcs8);
        expect(msg).not.toContain(k.seed.toString("base64"));
        expect(msg).not.toContain(k.seed.toString("hex"));
      }
      expect(() => resolveAgentKeyPath("kern")).toThrow(AgentKeyConflictError);
    });
  });

  test("the SAME key in both places (even in different formats) is fine — it is the key", () => {
    withHome(() => {
      const k = makeKey();
      put(flairKey("kern"), k.b64Pkcs8);
      put(identityKey("kern"), k.seed);
      expect(readAgentPrivateKey("kern")!.equals(k.seed)).toBe(true);
      expect(resolveAgentKeyPath("kern")).toBe(flairKey("kern"));
    });
  });

  test("a MALFORMED second key is an error naming it — a key file is never skipped", () => {
    withHome(() => {
      put(flairKey("kern"), makeKey().seed);
      put(identityKey("kern"), "not a key at all");
      let caught: unknown = null;
      try {
        readAgentPrivateKey("kern");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentKeyError);
      expect((caught as AgentKeyError).path).toBe(identityKey("kern"));
    });
  });

  test("a MALFORMED first key is an error naming it — never a silent fall-through to the next location", () => {
    withHome(() => {
      put(flairKey("kern"), "not a key at all");
      put(identityKey("kern"), makeKey().seed);
      let caught: unknown = null;
      try {
        readAgentPrivateKey("kern");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AgentKeyError);
      expect((caught as AgentKeyError).path).toBe(flairKey("kern"));
      expect((caught as Error).message).toContain(flairKey("kern"));
    });
  });

  test("no key anywhere → null (the caller refuses and names both paths)", () => {
    withHome(() => {
      expect(resolveAgentKeyPath("nobody")).toBeNull();
      expect(readAgentPrivateKey("nobody")).toBeNull();
    });
  });

  test("TPS_TEST_KEYS_DIR REPLACES the search path — a test can never resolve a HOME key", () => {
    withHome(() => {
      put(identityKey("ember"), makeKey().seed);
      const dir = mkdtempSync(join(tmpdir(), "tps-keyres-test-"));
      process.env.TPS_TEST_KEYS_DIR = dir;
      try {
        expect(agentKeyCandidates("ember")).toEqual([join(dir, "ember.key")]);
        expect(readAgentPrivateKey("ember")).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("readPrivateKeyAtPath names the path of a malformed explicit key", () => {
    withHome(() => {
      const p = join(home, "explicit.key");
      put(p, Buffer.alloc(40, 0x07));
      expect(() => readPrivateKeyAtPath(p)).toThrow(p);
    });
  });
});
