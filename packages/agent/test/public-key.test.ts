/**
 * public-key.test.ts — cli#493: the ONE parser for a hub-returned public key.
 *
 * `parseFlairPublicKey` decodes the encodings the Flair hub stores — unpadded
 * base64url and standard base64 (padded or unpadded) — to the raw 32 bytes
 * verifyEnvelope needs, and refuses everything else.
 */
import { expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { createHash } from "node:crypto";
import { PublicKeyFormatError, parseFlairPublicKey } from "../src/lib/public-key.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function pub(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

/** A 32-byte seed whose public key's base64url carries a '-' or '_'. */
function seedWithUrlChar(): Buffer {
  for (let i = 0; i < 256; i++) {
    const candidate = Buffer.alloc(32, i);
    const encoded = pub(candidate).toString("base64url");
    if (encoded.includes("-") || encoded.includes("_")) return candidate;
  }
  throw new Error("no single-byte seed produced a base64url key with '-' or '_'");
}

const KEY = pub(Buffer.alloc(32, 0x11));

test("accepts an unpadded base64url key", () => {
  expect(parseFlairPublicKey(KEY.toString("base64url"))).toEqual(KEY);
});

test("accepts a base64url key carrying '-' or '_'", () => {
  const encoded = pub(seedWithUrlChar()).toString("base64url");
  expect(encoded).toHaveLength(43);
  expect(encoded).toMatch(/[-_]/);
  expect(parseFlairPublicKey(encoded)).toEqual(pub(seedWithUrlChar()));
});

test("accepts a standard padded base64 key", () => {
  expect(parseFlairPublicKey(KEY.toString("base64"))).toEqual(KEY);
});

test("accepts a standard unpadded base64 key", () => {
  expect(parseFlairPublicKey(KEY.toString("base64").replace(/=+$/, ""))).toEqual(KEY);
});

test("refuses a 31-byte value", () => {
  expect(() => parseFlairPublicKey(Buffer.alloc(31, 0x01).toString("base64url"))).toThrow(
    PublicKeyFormatError,
  );
});

test("refuses a 33-byte value", () => {
  expect(() => parseFlairPublicKey(Buffer.alloc(33, 0x01).toString("base64url"))).toThrow(
    PublicKeyFormatError,
  );
});

test("refuses characters outside base64/base64url", () => {
  expect(() => parseFlairPublicKey("not-a-key!!")).toThrow(PublicKeyFormatError);
});

test("refuses a non-string or empty value", () => {
  expect(() => parseFlairPublicKey(undefined)).toThrow(PublicKeyFormatError);
  expect(() => parseFlairPublicKey("")).toThrow(PublicKeyFormatError);
});

test("refuses a value that mixes the base64 and base64url alphabets", () => {
  const mixed = "ab+cd-efgh";
  expect(mixed).toMatch(/\+/);
  expect(mixed).toMatch(/-/);
  expect(() => parseFlairPublicKey(mixed)).toThrow(PublicKeyFormatError);
});

test("refuses a non-canonical encoding that decodes to the same 32 bytes", () => {
  const canonical = KEY.toString("base64").replace(/=+$/, "");
  const idx = ALPHABET.indexOf(canonical.at(-1)!);
  // Flip the two padding bits of the final character: same bytes, different text.
  const mutated = canonical.slice(0, -1) + ALPHABET[idx ^ 3];
  expect(mutated).not.toBe(canonical);
  expect(() => parseFlairPublicKey(mutated)).toThrow(PublicKeyFormatError);
});
