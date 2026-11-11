/**
 * sent-envelope.ts — the SIGNED envelope of an outbound message, keyed by its
 * envelope `messageId`, so `tps mail send --message-id <id>` can re-send the
 * same signed bytes rather than sign a fresh envelope. Signing again would put
 * a fresh `timestamp` inside the envelope and a fresh signature on it; the
 * branch compares the accepted payload (from, to, timestamp and content), so a
 * freshly signed copy of the same message is a payload CONFLICT, not a
 * duplicate. Storing the first signed envelope is what makes the id a stable
 * delivery key.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSignedEnvelope, type ChainEntry, type Envelope, type FlairClient } from "@tpsdev-ai/agent";
import * as ed from "@noble/ed25519";
import canonicalize from "canonicalize";

/** How long a stored signed envelope can be reused, in milliseconds. The window
 *  defaults to the branch's acceptance-receipt window; the branch's value is
 *  overridable with TPS_RELAY_ACCEPT_RECEIPT_TTL_MS. A re-send later than this
 *  is a new delivery attempt. */
export const SENT_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DIR_NAME = ".sent-envelopes";

/** A stored signed envelope that cannot be read, parsed or matched. Refusing
 *  is the only safe answer: re-signing would send a different signed message
 *  under an id the branch may already hold. */
export class StoredEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredEnvelopeError";
  }
}

interface EnvelopeFields {
  messageId: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

/** What this invocation expects the stored envelope to hold: the message it
 *  sends, the --reply-to it names, and the inbound delegation chain it would
 *  embed on a fresh send (`null` when TPS_INBOUND_CHAIN_JSON is absent or
 *  empty). */
interface StoredEnvelopeExpectation {
  from: string;
  to: string;
  body: string;
  replyToId?: string;
  priorChain?: ChainEntry[] | null;
}

/** The chain a fresh send embeds when TPS_INBOUND_CHAIN_JSON is absent: one
 *  origination entry, timestamped with the envelope timestamp. */
function defaultPriorChain(timestamp: string): ChainEntry[] {
  return [
    {
      agent: "system",
      kind: "human",
      timestamp,
      rationale: "tps mail send (no inbound chain)",
      signature: null,
    },
  ];
}

/** True when the stored chain prefix (every entry before the sender's own) is
 *  exactly the prior chain this invocation would embed, compared canonically. */
function sameInboundChain(prefix: ChainEntry[], expected: ChainEntry[]): boolean {
  if (prefix.length !== expected.length) return false;
  const stored = canonicalize(prefix);
  const wanted = canonicalize(expected);
  return stored !== undefined && stored === wanted;
}

function decodeSignature(value: string | null | undefined): Uint8Array | null {
  if (value == null) return null;
  const prefix = "ed25519:";
  if (!value.startsWith(prefix)) return null;
  try {
    return new Uint8Array(Buffer.from(value.slice(prefix.length), "base64"));
  } catch {
    return null;
  }
}

/** The result of checking a stored envelope. A `structural` failure means the
 *  bytes are not a valid signed envelope at all; a `signature` failure means the
 *  shape is valid but a key or signature check refused it. The caller reports
 *  them differently. */
type StoredVerifyResult = { ok: true } | { ok: false; kind: "structural" | "signature"; reason: string };

/**
 * Verify a stored envelope with the sender's CURRENT key: the outer signature
 * and the sender's own (last) chain entry. Earlier delegation hops are NOT
 * resolved or verified — their keys are normally not on this host. The outer
 * signature covers every byte of the chain, and the chain prefix is required to
 * be the one this invocation would embed.
 */
async function verifyStoredEnvelope(envelope: Envelope, client: FlairClient): Promise<StoredVerifyResult> {
  if (envelope.v !== 1) return { ok: false, kind: "structural", reason: "unsupported version" };
  const chain = envelope.delegationChain;
  if (!Array.isArray(chain) || chain.length === 0) return { ok: false, kind: "structural", reason: "missing chain" };
  if (chain.length > 16) return { ok: false, kind: "structural", reason: "chain too long" };
  const tip = chain[chain.length - 1];
  if (tip.agent !== envelope.from) return { ok: false, kind: "structural", reason: "chain tip / from mismatch" };
  for (const entry of chain) {
    if (entry.kind === "human" && entry.signature !== null) {
      return { ok: false, kind: "structural", reason: "human entry must have null signature" };
    }
  }
  const info = await client.getAgent(envelope.from);
  if (!info) return { ok: false, kind: "signature", reason: `no current key for agent "${envelope.from}"` };
  const publicKey = new Uint8Array(info.publicKey);

  const entrySig = decodeSignature(tip.signature);
  if (!entrySig) return { ok: false, kind: "signature", reason: "sender's chain entry signature invalid" };
  const entryForSig = {
    agent: tip.agent,
    kind: tip.kind,
    timestamp: tip.timestamp,
    rationale: tip.rationale,
    signature: undefined,
  } as const;
  const entryCanonical = canonicalize({ prior: chain.slice(0, -1), entry: entryForSig });
  if (entryCanonical === undefined || !(await ed.verifyAsync(entrySig, new TextEncoder().encode(entryCanonical), publicKey))) {
    return { ok: false, kind: "signature", reason: "sender's chain entry signature invalid" };
  }

  const outerSig = decodeSignature(envelope.signature);
  if (!outerSig) return { ok: false, kind: "signature", reason: "outer signature invalid" };
  const { signature: _, ...withoutSignature } = envelope;
  const outerCanonical = canonicalize(withoutSignature);
  if (outerCanonical === undefined || !(await ed.verifyAsync(outerSig, new TextEncoder().encode(outerCanonical), publicKey))) {
    return { ok: false, kind: "signature", reason: "outer signature invalid" };
  }
  return { ok: true };
}

/** The stored path for one id. The id is hashed because the envelope id shape
 *  permits `.` and `..`, which must never reach a path segment. */
function envelopePath(root: string, messageId: string): string {
  const key = createHash("sha256").update(messageId, "utf8").digest("hex");
  return join(root, DIR_NAME, `${key}.json`);
}

function parseStored(raw: string, path: string): EnvelopeFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is not valid JSON; refusing to send`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is not an envelope; refusing to send`);
  }
  const env = parsed as Record<string, unknown>;
  if (
    typeof env.messageId !== "string" ||
    typeof env.from !== "string" ||
    typeof env.to !== "string" ||
    typeof env.body !== "string" ||
    typeof env.timestamp !== "string"
  ) {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is missing envelope fields; refusing to send`);
  }
  return { messageId: env.messageId, from: env.from, to: env.to, body: env.body, timestamp: env.timestamp };
}

/** Refuse a stored envelope whose chain prefix (every entry before the
 *  sender's own) is not the inbound chain THIS invocation would embed: a
 *  delegated send embeds the inbound chain it was given without verifying it,
 *  so a re-send must carry the same delegation history as the fresh send. */
function assertSameInboundChain(envelope: Envelope, expected: StoredEnvelopeExpectation): void {
  const priorChain = expected.priorChain ?? defaultPriorChain(envelope.timestamp);
  if (!sameInboundChain(envelope.delegationChain.slice(0, -1), priorChain)) {
    throw new StoredEnvelopeError(
      `the inbound delegation chain differs from the stored message's; refusing to re-send --message-id ${envelope.messageId}`,
    );
  }
}

/** Read the signed envelope stored for `messageId` when it is the same message
 *  and still verifies with the sender's CURRENT key. Returns undefined when no
 *  entry exists. The entry is only ours if it is a regular file, readable only
 *  by its owner, and owned by this user: otherwise reusing it would send bytes
 *  this process cannot vouch for. */
export async function readSentEnvelope(
  root: string,
  messageId: string,
  expected: StoredEnvelopeExpectation,
  client: FlairClient,
): Promise<string | undefined> {
  const path = envelopePath(root, messageId);
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StoredEnvelopeError(
      `cannot read the stored signed message at ${path}: ${error instanceof Error ? error.message : String(error)}; refusing to send`,
    );
  }
  if (!entry.isFile()) {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is not a regular file; refusing to send`);
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new StoredEnvelopeError(
      `the stored signed message at ${path} is readable by group or others (mode 0${(entry.mode & 0o777).toString(8)}); refusing to send`,
    );
  }
  const getuid = process.getuid;
  // A platform without process.getuid cannot compare owners; skip only there.
  if (typeof getuid === "function" && entry.uid !== getuid()) {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is not owned by this user; refusing to send`);
  }
  if (Date.now() - entry.mtimeMs >= SENT_ENVELOPE_TTL_MS) {
    try {
      unlinkSync(path);
    } catch {
      /* another process pruned it; the entry is expired either way */
    }
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StoredEnvelopeError(
      `cannot read the stored signed message at ${path}: ${error instanceof Error ? error.message : String(error)}; refusing to send`,
    );
  }
  const env = parseStored(raw, path);
  if (env.messageId !== messageId || env.from !== expected.from || env.to !== expected.to || env.body !== expected.body) {
    throw new StoredEnvelopeError(`--message-id ${messageId} was already used to sign a different message; use a new --message-id`);
  }
  const parsed = parseSignedEnvelope(raw);
  if (!parsed.ok) {
    throw new StoredEnvelopeError(`the stored signed message at ${path} is not a valid signed envelope (${parsed.reason}); refusing to send`);
  }
  const signed = parsed.envelope;
  if ((signed.replyToId ?? undefined) !== (expected.replyToId ?? undefined)) {
    throw new StoredEnvelopeError(`--message-id ${messageId} was already used to sign a message with a different --reply-to; use a new --message-id`);
  }
  // A delegated send embeds the inbound chain it was given without verifying
  // it. The stored envelope's chain prefix must therefore be the chain THIS
  // invocation would embed; otherwise a re-send would carry a different
  // delegation history than the fresh send.
  assertSameInboundChain(signed, expected);
  const verified = await verifyStoredEnvelope(signed, client);
  if (!verified.ok) {
    if (verified.kind === "structural") {
      throw new StoredEnvelopeError(
        `the stored message at ${path} is not a valid signed envelope (${verified.reason})`,
      );
    }
    throw new StoredEnvelopeError(
      `the stored signed message at ${path} does not verify against agent "${expected.from}"'s current key (${verified.reason}); refusing to send`,
    );
  }
  return raw;
}

/** Store the first signed envelope for `messageId`, or return the one another
 *  process stored first for the same message. */
export async function storeSentEnvelope(
  root: string,
  messageId: string,
  signed: string,
  expected: StoredEnvelopeExpectation,
  client: FlairClient,
): Promise<string> {
  const dir = join(root, DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneExpired(dir);
  const path = envelopePath(root, messageId);
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, signed, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      return signed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StoredEnvelopeError(
          `cannot store the signed message for --message-id ${messageId} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const existing = await readSentEnvelope(root, messageId, expected, client);
      if (existing !== undefined) return existing;
      if (attempt >= 1) {
        throw new StoredEnvelopeError(`the stored signed message for --message-id ${messageId} vanished while writing; retry`);
      }
    }
  }
}

/** Drop entries older than the reuse window. Best effort: read-time expiry
 *  ignores a leftover entry, and a failed prune never sends anything. */
function pruneExpired(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SENT_ENVELOPE_TTL_MS;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      /* another process pruned it, or it is unreadable; leave it */
    }
  }
}
