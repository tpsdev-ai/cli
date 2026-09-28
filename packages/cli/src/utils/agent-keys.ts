/**
 * agent-keys.ts — resolve and read Ed25519 private key seeds for TPS agents.
 *
 * WHERE A KEY IS LOOKED FOR (cli#429). One precedence, used by every signer
 * that resolves a key by agent id (`tps mail send`, the openclaw-tps-mail
 * plugin's replies and nacks):
 *
 *   1. ~/.flair/keys/<id>.key    — the Flair key: what the fleet's agents use
 *                                   and what `bob onboard` writes.
 *   2. ~/.tps/identity/<id>.key  — the identity key `tps init` and
 *                                   `tps agent create` generate (and register
 *                                   with Flair).
 *
 * The FIRST file that exists is the key; a later location is never consulted
 * once an earlier one exists, so an agent that signs today keeps signing with
 * the same key. A file that exists but cannot be read or parsed is an ERROR
 * naming that path (AgentKeyError) — never a silent fall-through to the next
 * location. TPS_TEST_KEYS_DIR (tests) REPLACES the whole search path with
 * `<dir>/<id>.key`, so a test can never resolve a real key.
 *
 * FORMATS. Every accepted format is normalized to the 32-byte seed that
 * @noble/ed25519 signing expects, and each is parsed STRICTLY — a file is one
 * key and nothing else:
 *   - a raw 32-byte seed (e.g. flint's key; also what `tps init` and
 *     `tps agent create` write);
 *   - base64-encoded PKCS8 DER on one line — the canonical Flair key format
 *     (`openssl pkcs8 -topk8 -nocrypt -outform DER | base64`): canonical
 *     base64 only;
 *   - raw PKCS8 DER bytes;
 *   - PEM PKCS8 — exactly ONE unencrypted `-----BEGIN PRIVATE KEY-----` block,
 *     nothing before or after it but whitespace, a strict base64 body, the
 *     format `bob onboard` writes.
 * In every DER form the outer structure must span the whole input (no trailing
 * or missing bytes), node:crypto must accept it as an UNENCRYPTED PKCS8 key,
 * and the key must be Ed25519. Encrypted keys and other algorithms are
 * refused by name.
 *
 * ERRORS NEVER CARRY KEY MATERIAL. Format errors (KeyFormatError) describe the
 * structure (sizes, counts, the key type) and never quote the input; node's
 * own error text is never passed through. AgentKeyError adds the path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createPrivateKey, type KeyObject } from "node:crypto";

/** A key file's CONTENT is not a usable Ed25519 private key. Never quotes the content. */
export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFormatError";
  }
}

/** A key file exists but cannot be used: unreadable or malformed. Names the path. */
export class AgentKeyError extends Error {
  readonly path: string;
  readonly kind: "unreadable" | "malformed";
  constructor(path: string, kind: "unreadable" | "malformed", detail: string) {
    super(
      kind === "unreadable"
        ? `the Ed25519 private key at ${path} could not be read (${detail})`
        : `the Ed25519 private key at ${path} is malformed: ${detail}`,
    );
    this.name = "AgentKeyError";
    this.path = path;
    this.kind = kind;
  }
}

/**
 * The paths searched for an agent's key, in precedence order (see the header).
 * Under TPS_TEST_KEYS_DIR the list is that one directory's file only.
 */
export function agentKeyCandidates(agentName: string): string[] {
  const file = `${agentName}.key`;
  if (process.env.TPS_TEST_KEYS_DIR) return [join(process.env.TPS_TEST_KEYS_DIR, file)];
  // The live $HOME first, like `tps init` (resolveHome) and identity.ts: bun's
  // os.homedir() can disagree with a HOME set after start.
  const home = process.env.HOME || homedir();
  return [join(home, ".flair", "keys", file), join(home, ".tps", "identity", file)];
}

/** The first existing key file in agentKeyCandidates() order, or null when none exists. */
export function resolveAgentKeyPath(agentName: string): string | null {
  for (const candidate of agentKeyCandidates(agentName)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read an agent's Ed25519 private key and return the 32-byte signing seed.
 * Returns null when NO candidate file exists; throws AgentKeyError when the
 * resolved file cannot be read or is not a valid key.
 */
export function readAgentPrivateKey(agentName: string): Buffer | null {
  const path = resolveAgentKeyPath(agentName);
  if (path === null) return null;
  return readPrivateKeyAtPath(path);
}

/**
 * Read an Ed25519 private key from an EXPLICIT path, normalized to the 32-byte
 * seed. The agent runtimes are configured with `flairKeyPath` (which need not be
 * a default location), so outbound signing must honor it rather than silently
 * resolving a different key than the runtime authenticates with.
 * Returns null if the file does not exist; throws AgentKeyError when it cannot
 * be read or is not a valid key.
 */
export function readPrivateKeyAtPath(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    throw new AgentKeyError(path, "unreadable", typeof code === "string" ? code : "read error");
  }
  try {
    return toEd25519Seed(raw);
  } catch (err) {
    // Only our own KeyFormatError text is passed on: it never quotes the input.
    throw new AgentKeyError(path, "malformed", err instanceof KeyFormatError ? err.message : "not a usable Ed25519 private key");
  }
}

const FORMATS =
  "expected a raw 32-byte seed, one line of base64 PKCS8 DER, raw PKCS8 DER, " +
  'or exactly one unencrypted PEM "PRIVATE KEY" block';

/**
 * Normalize a stored Ed25519 private key to its raw 32-byte seed, strictly
 * (see FORMATS in the header). Throws KeyFormatError, which never carries key
 * material. Exported for unit tests.
 */
export function toEd25519Seed(raw: Buffer): Buffer {
  // Already a raw 32-byte seed (e.g. flint's key; `tps init` / `agent create`).
  if (raw.length === 32) return Buffer.from(raw);

  const text = raw.toString("utf8");

  // PEM: any armor at all routes here, and a PEM-looking file that is not
  // exactly one valid block is an error — it is never re-read as another form.
  if (text.includes("-----BEGIN") || text.includes("-----END")) return seedFromPem(text);

  // One line of base64 PKCS8 DER (the canonical Flair key format).
  const trimmed = text.trim();
  if (trimmed.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    const der = strictBase64(trimmed);
    if (!der) throw new KeyFormatError("the base64 key text is not canonical base64");
    return seedFromPkcs8Der(der);
  }

  // Raw PKCS8 DER bytes (a DER SEQUENCE starts with 0x30).
  if (raw.length > 0 && raw[0] === 0x30) return seedFromPkcs8Der(raw);

  throw new KeyFormatError(`Unrecognized Ed25519 private key format (${raw.length} bytes); ${FORMATS}`);
}

const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";
const PEM_BEGIN_ENCRYPTED = "-----BEGIN ENCRYPTED PRIVATE KEY-----";

/**
 * Exactly one unencrypted PKCS8 PEM block, nothing but whitespace around it, a
 * body of plain base64 lines (no RFC 1421 headers), canonical base64 once
 * joined, and a DER payload that passes seedFromPkcs8Der.
 */
function seedFromPem(text: string): Buffer {
  const begins = text.split("-----BEGIN").length - 1;
  const ends = text.split("-----END").length - 1;
  if (begins !== 1 || ends !== 1) {
    throw new KeyFormatError(
      `expected exactly one PEM block, found ${begins} BEGIN and ${ends} END marker(s)`,
    );
  }
  const lines = text.trim().split(/\r?\n/);
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  if (first === PEM_BEGIN_ENCRYPTED) {
    throw new KeyFormatError(
      "the PEM key is ENCRYPTED; the signer needs an unencrypted PKCS8 key " +
        "(write an unencrypted copy with `openssl pkey -in <file> -out <new file>` and install that)",
    );
  }
  if (first !== PEM_BEGIN || last !== PEM_END) {
    throw new KeyFormatError(
      'the PEM block must be one unencrypted PKCS8 "PRIVATE KEY" block with nothing before or after it',
    );
  }
  const body = lines.slice(1, -1);
  if (body.length === 0 || body.some((line) => !/^[A-Za-z0-9+/=]+$/.test(line))) {
    throw new KeyFormatError("the PEM body is not plain base64 lines (PEM headers are not supported)");
  }
  const der = strictBase64(body.join(""));
  if (!der) throw new KeyFormatError("the PEM body is not canonical base64");
  return seedFromPkcs8Der(der);
}

/**
 * Decode CANONICAL base64 only: full 4-char groups, padding only at the end,
 * and a round trip that reproduces the input (so stray bits and characters
 * node's lenient decoder would skip are refused). Null when not canonical.
 */
function strictBase64(s: string): Buffer | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s ? buf : null;
}

/**
 * The byte length the OUTER DER SEQUENCE declares (header + content), or null
 * when the input does not start with a minimally encoded SEQUENCE header.
 */
function derOuterLength(der: Buffer): number | null {
  if (der.length < 2 || der[0] !== 0x30) return null;
  const first = der.readUInt8(1);
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4 || der.length < 2 + n || der[2] === 0) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + der.readUInt8(2 + i);
  if (len < 0x80) return null; // DER requires the short form below 128
  return 2 + n + len;
}

/**
 * The 32-byte seed from PKCS8 DER, strictly: the outer SEQUENCE must span the
 * WHOLE input, node:crypto must accept it as an unencrypted PKCS8 key, and the
 * key must be Ed25519. The seed is read from node's JWK `d` (no hardcoded
 * ASN.1 offsets).
 */
function seedFromPkcs8Der(der: Buffer): Buffer {
  const declared = derOuterLength(der);
  if (declared === null) throw new KeyFormatError(`not a DER-encoded PKCS8 key (${der.length} bytes)`);
  if (declared !== der.length) {
    throw new KeyFormatError(
      `the DER key structure is ${declared} bytes but the input is ${der.length} bytes (trailing or missing data)`,
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new KeyFormatError("not a valid unencrypted PKCS8 private key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new KeyFormatError(`not an Ed25519 key (the PKCS8 key type is ${key.asymmetricKeyType ?? "unknown"})`);
  }
  const d = (key.export({ format: "jwk" }) as { d?: string }).d;
  const seed = typeof d === "string" ? Buffer.from(d, "base64url") : Buffer.alloc(0);
  if (seed.length !== 32) throw new KeyFormatError("the Ed25519 key does not carry a 32-byte seed");
  return seed;
}


/**
 * Parse TPS_INBOUND_CHAIN_JSON into a ChainEntry array.
 * Returns null if unset, empty, or invalid.
 */
import type { ChainEntry } from "@tpsdev-ai/agent";

export function parseInboundChain(raw: string | undefined): ChainEntry[] | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Basic shape validation: every entry must have agent, kind, timestamp, rationale
    for (const entry of parsed) {
      if (
        typeof entry !== "object" ||
        typeof entry.agent !== "string" ||
        typeof entry.kind !== "string" ||
        typeof entry.timestamp !== "string" ||
        typeof entry.rationale !== "string"
      ) {
        return null;
      }
      if (entry.kind !== "human" && entry.kind !== "agent") return null;
      if (entry.signature !== null && entry.signature !== undefined && typeof entry.signature !== "string") return null;
    }
    return parsed as ChainEntry[];
  } catch {
    return null;
  }
}
