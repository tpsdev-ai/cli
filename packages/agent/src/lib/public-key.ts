const ED25519_KEY_BYTES = 32;

/** The two base64 alphabets plus optional trailing '=' padding. */
const BASE64_SHAPED = /^[A-Za-z0-9+/_-]*={0,2}$/;
/** The standard base64 alphabet only (after base64url is normalized). */
const STANDARD_BASE64_BODY = /^[A-Za-z0-9+/]+$/;

export class PublicKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicKeyFormatError";
  }
}

/** Decode uniform-case hex or canonical base64/base64url to exactly 32 bytes. */
export function parseFlairPublicKey(encoded: unknown): Buffer {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new PublicKeyFormatError("a public key must be a non-empty string");
  }
  if (encoded.length === 64 && /^(?:[0-9a-f]{64}|[0-9A-F]{64})$/.test(encoded)) {
    return Buffer.from(encoded, "hex");
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
  const canonical = decoded.toString("base64");
  const unpadded = canonical.replace(/=+$/, "");
  const normalized = usesUrl ? encoded.replace(/-/g, "+").replace(/_/g, "/") : encoded;
  if (normalized !== canonical && normalized !== unpadded) {
    throw new PublicKeyFormatError("a public key is not canonical base64/base64url");
  }
  return decoded;
}
