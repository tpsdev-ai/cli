/**
 * public-key.ts — the ONE parser for a Flair-returned Ed25519 public key.
 *
 * The Flair hub stores and returns an agent's public key as UNPADDED base64url
 * (43 characters for a 32-byte key, and it may carry '-' or '_'). This parser
 * also accepts standard base64, padded or unpadded, and turns any of them into
 * the raw 32 bytes `verifyEnvelope` needs. Every call site that converts a
 * hub/Flair-returned key string into those bytes routes through it.
 *
 * It accepts base64url and standard base64 in either padding, and refuses
 * everything else: a non-string, an empty string, a character outside the two
 * alphabets, a value that mixes the alphabets, a value that is not canonical
 * for its length, and any value that does not decode to exactly 32 bytes.
 */

/** A 32-byte Ed25519 public key. */
const ED25519_KEY_BYTES = 32;

/** The two base64 alphabets plus optional trailing '=' padding. */
const BASE64_SHAPED = /^[A-Za-z0-9+/_-]*={0,2}$/;
/** The standard base64 alphabet only (after base64url is normalized). */
const STANDARD_BASE64_BODY = /^[A-Za-z0-9+/]+$/;

/** Thrown when a string cannot be read as a 32-byte Ed25519 public key. */
export class PublicKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicKeyFormatError";
  }
}

/**
 * Decode a hub/Flair-returned Ed25519 public key to its raw 32 bytes.
 *
 * Accepts unpadded base64url and standard base64 (padded or unpadded); throws
 * `PublicKeyFormatError` for anything that is not exactly a 32-byte key.
 */
export function parseFlairPublicKey(encoded: unknown): Buffer {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new PublicKeyFormatError("a public key must be a non-empty string");
  }
  if (!BASE64_SHAPED.test(encoded)) {
    throw new PublicKeyFormatError("a public key contains characters outside base64/base64url");
  }
  const body = encoded.replace(/=+$/, "");
  const usesStandard = /[+/]/.test(body);
  const usesUrl = /[-_]/.test(body);
  if (usesStandard && usesUrl) {
    throw new PublicKeyFormatError("a public key mixes the base64 and base64url alphabets");
  }
  const standard = usesUrl ? body.replace(/-/g, "+").replace(/_/g, "/") : body;
  if (!STANDARD_BASE64_BODY.test(standard)) {
    throw new PublicKeyFormatError("a public key is not valid base64/base64url");
  }
  const decoded = Buffer.from(standard, "base64");
  if (decoded.length !== ED25519_KEY_BYTES) {
    throw new PublicKeyFormatError(
      `a public key must decode to ${ED25519_KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  // Reject a non-canonical encoding: the decoded bytes must re-encode to the
  // same body. This refuses trailing-bit variants that decode to the same 32
  // bytes but are not the encoding the key was written in.
  if (decoded.toString("base64").replace(/=+$/, "") !== standard) {
    throw new PublicKeyFormatError("a public key is not canonical base64/base64url");
  }
  return decoded;
}
