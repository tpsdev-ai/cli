/**
 * receipt-scan.test.ts — cli#398 round 2, item 3, extended for cli#389 round 3
 * and cli#429.
 *
 * TWO receipt forms and ONE rule: the receipt must name THIS obligation AND the
 * inbound it answers — and (cli#429) the reply it carries must be a VERIFIED
 * signed reply by the obligated agent for this thread. Every field either form
 * is checked on is pinned here, so the docblock cannot drift from the code
 * again.
 *
 * (1) METADATA (`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json`,
 *     cli#389 round 3; per-agent since round 5): read by its DIRECT path — no
 *     directory parse — and accepted only when `obligationId` matches,
 *     `replyToId` is the thread this obligation is keyed on, and its
 *     `signedReply` verifies. That is what makes a REUSED obligation id safe: a
 *     receipt minted for another inbound (or an older reply) never satisfies it.
 * (2) POSTED FILE: matched on the obligation marker, the accountId, the record
 *     `from` and `replyToId` — OR (cli#389 round 5, item 2) on the obligation ids
 *     `deliverToSandbox` writes into its reduced record and the record `from`.
 *
 * Every form is then held to the SIGNATURE rule (cli#429): a candidate whose
 * reply is unsigned, whose signature does not verify, or that another agent
 * signed is NOT a receipt. The signature check here is the real verifyEnvelope
 * against a key table this suite controls (the plugin hands the scan the same
 * check, backed by Flair).
 *
 * The `replyToId` rows below are cli#389 round 3, item 3; the `replyId` rows are
 * cli#389 round 6, item 1 (the obligation record's own `replyId`, when it has
 * one, must match the receipt's).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  existsSync as realExistsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync as realReaddirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope, verifyEnvelope, type ChainEntry, type Envelope } from "@tpsdev-ai/agent";

import {
  receiptThread,
  scanForReceipt,
  type ReceiptScanDirs,
  type ReceiptScanOptions,
  type ReceiptSignatureCheck,
} from "../src/obligations.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const AGENT = "anvil";
const ACCOUNT = "default";
const OB_ID = "ob-1";
const INBOUND = "inbound-1";
/** The inbound's SIGNED envelope id: the thread a current obligation's reply carries. */
const THREAD = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

const AGENT_SEED = Buffer.alloc(32, 0x0a); // the obligated agent's key
const OTHER_SEED = Buffer.alloc(32, 0x0b); // another agent's key

const pub = (seed: Buffer): Buffer => Buffer.from(ed.getPublicKey(new Uint8Array(seed)));

/** The keys "Flair" holds — the table the signature check resolves principals from. */
const FLAIR_KEYS: Record<string, Buffer> = { [AGENT]: pub(AGENT_SEED), "someone-else": pub(OTHER_SEED) };

/** The check the plugin wires (verifyEnvelope against Flair's keys), backed by FLAIR_KEYS. */
const check: ReceiptSignatureCheck = async (env) =>
  (
    await verifyEnvelope(env, {
      async getAgent(name: string) {
        const k = FLAIR_KEYS[name];
        return k ? { publicKey: k } : null;
      },
    })
  ).ok;

/**
 * A reply envelope, as JSON. By default a GENUINE signed reply by AGENT (legacy
 * shape: no thread inside). `replyToId` puts a thread inside the signature;
 * `from`/`seed` choose the claimed sender and the key that actually signs;
 * `unsigned` returns the envelope with no signatures at all; `tamper` changes
 * the body AFTER signing, so the signature no longer verifies.
 */
function replyJson(
  over: { from?: string; seed?: Buffer; replyToId?: string; unsigned?: boolean; tamper?: boolean } = {},
): string {
  const from = over.from ?? AGENT;
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "tps-mail dispatcher reply", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatcher reply`, signature: null },
  ];
  const env: Envelope = { v: 1, from, to: "flint", body: "the answer", messageId: randomUUID(), timestamp: now, delegationChain: chain };
  if (over.replyToId !== undefined) env.replyToId = over.replyToId;
  if (over.unsigned) return JSON.stringify(env);
  const signed = signEnvelope(env, { [from]: over.seed ?? AGENT_SEED });
  if (over.tamper) signed.body = "a different answer";
  return JSON.stringify(signed);
}

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-receipt-home-"));
  dir = mkdtempSync(join(tmpdir(), "tps-receipt-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

/** The receipts dir for an agent — inside its own obligation store. */
const receiptsRoot = (): string => join(home, "mail", AGENT, ".obligations", "receipts");

/** Scan with the suite's signature check. Legacy thread mode unless `opts` says otherwise. */
async function scan(dirs: ReceiptScanDirs, thread = INBOUND, opts: ReceiptScanOptions = {}) {
  return scanForReceipt(dirs, OB_ID, thread, AGENT, ACCOUNT, check, opts);
}
const posted = (thread = INBOUND, opts: ReceiptScanOptions = {}) => scan({ direct: [], posted: [dir] }, thread, opts).then((s) => s.status);
const direct = (thread = INBOUND, opts: ReceiptScanOptions = {}) => scan({ direct: [receiptsRoot()], posted: [] }, thread, opts).then((s) => s.status);

/** A reply record with every pinned field right; `over` spoils exactly one. */
function reply(
  over: Partial<{ accountId: string; from: string; marker: string; replyToId: string; body: string }> = {},
): any {
  return {
    id: "reply-1",
    to: "flint",
    from: over.from ?? AGENT,
    accountId: over.accountId ?? ACCOUNT,
    replyToId: over.replyToId ?? INBOUND,
    // The wrapper body is the signed envelope JSON, exactly as delivered.
    body: over.body ?? replyJson(),
    headers: { "X-TPS-Obligation": over.marker ?? OB_ID },
    timestamp: new Date().toISOString(),
  };
}

function writeReply(rec: any): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-05-26T00-00-00-reply-1.json"), JSON.stringify(rec, null, 2), "utf-8");
}

/** Write a metadata receipt fixture by hand — the shape under test. */
function writeMetadataReceipt(record: Record<string, unknown>): string {
  const root = receiptsRoot();
  mkdirSync(root, { recursive: true });
  const path = join(root, `${String(record.obligationId)}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
  return path;
}

/** A metadata receipt with every pinned field right; `over` replaces fields. */
function metadata(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    replyId: "reply-1",
    obligationId: OB_ID,
    replyToId: INBOUND,
    route: "remote-branch",
    branchId: "tps-rockit",
    ts: new Date().toISOString(),
    signedReply: replyJson(),
    ...over,
  };
}

/**
 * The reduced record `deliverToSandbox` writes when the caller gives it the
 * obligation ids. It has NO headers and NO accountId — so of the posted-file
 * pins only `from`, the ids and the signed reply it carries can be checked.
 */
function sandboxRecord(
  over: Partial<{ obligationId: string; replyToId: string; from: string; body: string; replyId: string | null }> = {},
): any {
  const rec: any = {
    id: "sandbox-record-1",
    from: over.from ?? AGENT,
    to: "flint",
    body: over.body ?? replyJson(),
    timestamp: new Date().toISOString(),
    read: false,
    origin: "host",
    obligationId: over.obligationId ?? OB_ID,
    replyToId: over.replyToId ?? INBOUND,
    replyId: "reply-1",
  };
  if (over.replyId === null) delete rec.replyId;
  else if (typeof over.replyId === "string") rec.replyId = over.replyId;
  return rec;
}

describe("receipt scan — the POSTED FILE, every checked field pinned", () => {
  it("all pinned fields right + a verified signed reply → found (positive control)", async () => {
    writeReply(reply());
    expect(await posted()).toBe("found");
  });

  it("right marker + WRONG accountId → NOT found", async () => {
    writeReply(reply({ accountId: "some-other-account" }));
    expect(await posted()).toBe("absent");
  });

  it("right marker + WRONG record.from → NOT found", async () => {
    writeReply(reply({ from: "someone-else" }));
    expect(await posted()).toBe("absent");
  });

  it("WRONG marker (everything else right) → NOT found", async () => {
    writeReply(reply({ marker: "ob-2" }));
    expect(await posted()).toBe("absent");
  });

  it("item 3: the RIGHT obligation id but ANOTHER inbound (replyToId) → NOT found", async () => {
    writeReply(reply({ replyToId: "some-other-inbound" }));
    expect(await posted()).toBe("absent");
  });

  it("the recipient already promoted the reply (body = plaintext, the signed envelope stored beside it) → found", async () => {
    const env = JSON.parse(replyJson());
    writeReply({ ...reply(), body: env.body, envelope: env });
    expect(await posted()).toBe("found");
  });
});

// ── cli#429: the SIGNATURE rule, on every receipt form ─────────────────────

describe("receipt scan — cli#429: a matching record is evidence ONLY when its reply verifies", () => {
  const forgeries: Array<[string, () => string]> = [
    ["UNSIGNED (no signatures at all)", () => replyJson({ unsigned: true })],
    ["a signature that does NOT verify (body changed after signing)", () => replyJson({ tamper: true })],
    ["signed by ANOTHER key while claiming the obligated agent", () => replyJson({ seed: OTHER_SEED })],
    ["a genuine reply signed by ANOTHER agent", () => replyJson({ from: "someone-else", seed: OTHER_SEED })],
    ["not an envelope at all", () => "the answer, as plain text"],
  ];

  for (const [label, body] of forgeries) {
    it(`POSTED FILE: ${label} → NOT found`, async () => {
      writeReply(reply({ body: body() }));
      expect(await posted()).toBe("absent");
    });

    it(`BRIDGE SANDBOX RECORD: ${label} → NOT found`, async () => {
      writeReply(sandboxRecord({ body: body() }));
      expect(await posted()).toBe("absent");
    });

    it(`METADATA receipt: ${label} → NOT found`, async () => {
      writeMetadataReceipt(metadata({ signedReply: body() }));
      expect(await direct()).toBe("absent");
    });
  }

  it("POSTED FILE: a forged promoted-looking record (plaintext body, unsigned stored envelope) → NOT found", async () => {
    const env = JSON.parse(replyJson({ unsigned: true }));
    writeReply({ ...reply(), body: env.body, envelope: env });
    expect(await posted()).toBe("absent");
  });

  it("METADATA receipt with NO signed reply (the pre-cli#429 shape) → NOT found", async () => {
    const { signedReply: _omit, ...legacyShape } = metadata();
    writeMetadataReceipt(legacyShape);
    expect(await direct()).toBe("absent");
  });

  it("a signature check that THROWS (Flair unreachable) is not evidence — and a later scan that verifies finds it", async () => {
    writeReply(reply());
    const unreachable: ReceiptSignatureCheck = async () => {
      throw new Error("Flair unreachable");
    };
    expect((await scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, unreachable)).status).toBe("absent");
    expect(await posted()).toBe("found");
  });

  it("the scan hands the check the envelope the record carries, and nothing else is consulted", async () => {
    const body = replyJson();
    writeReply(reply({ body }));
    const seen: string[] = [];
    const spy: ReceiptSignatureCheck = async (env) => {
      seen.push(env.messageId);
      return check(env);
    };
    expect((await scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, spy)).status).toBe("found");
    expect(seen).toEqual([JSON.parse(body).messageId]);
  });
});

describe("receipt scan — the METADATA receipt, read by its DIRECT path", () => {
  it("matching obligation id + inbound + a verified signed reply → found (positive control)", async () => {
    writeMetadataReceipt(metadata());
    const s = await scan({ direct: [receiptsRoot()], posted: [] });
    expect(s.status).toBe("found");
    expect(s.status === "found" && s.path).toBe(join(receiptsRoot(), `${OB_ID}.json`));
  });

  it("item 3: the RIGHT obligation id but ANOTHER replyToId → NOT found", async () => {
    writeMetadataReceipt(metadata({ replyToId: "some-other-inbound", route: "bridge" }));
    expect(await direct()).toBe("absent");
  });

  it("item 1: the RIGHT obligation id + inbound but ANOTHER replyId than the record knows → NOT found", async () => {
    writeMetadataReceipt(metadata({ replyId: "reply-OTHER", route: "bridge" }));
    expect(await direct(INBOUND, { expectedReplyId: "reply-1" })).toBe("absent");
    // …and with the matching replyId it is found.
    writeMetadataReceipt(metadata({ replyId: "reply-1", route: "bridge" }));
    expect(await direct(INBOUND, { expectedReplyId: "reply-1" })).toBe("found");
  });

  it("a receipt for ANOTHER obligation id in the same dir does not satisfy this one", async () => {
    writeMetadataReceipt(metadata({ replyId: "reply-2", obligationId: "ob-2", route: "bridge" }));
    expect(await direct()).toBe("absent");
  });
});

describe("receipt scan — the BRIDGE SANDBOX RECORD (cli#389 round 5, item 2)", () => {
  it("the obligation ids + the agent's verified signed reply → found (positive control)", async () => {
    writeReply(sandboxRecord());
    expect(await posted()).toBe("found");
  });

  it("a WRONG obligationId → NOT found", async () => {
    writeReply(sandboxRecord({ obligationId: "ob-2" }));
    expect(await posted()).toBe("absent");
  });

  it("the RIGHT obligation id but ANOTHER inbound (replyToId) → NOT found", async () => {
    writeReply(sandboxRecord({ replyToId: "some-other-inbound" }));
    expect(await posted()).toBe("absent");
  });

  it("a WRONG record.from → NOT found", async () => {
    writeReply(sandboxRecord({ from: "someone-else" }));
    expect(await posted()).toBe("absent");
  });

  // ── cli#389 round 6, item 1: the reply binding ────────────────────────────

  it("item 1: the obligation record knows the reply → a sandbox record with the SAME replyId is found", async () => {
    writeReply(sandboxRecord({ replyId: "reply-1" }));
    expect(await posted(INBOUND, { expectedReplyId: "reply-1" })).toBe("found");
  });

  it("item 1: a sandbox record with correct obligation + inbound ids but a DIFFERENT replyId is NOT accepted", async () => {
    writeReply(sandboxRecord({ replyId: "reply-2" }));
    expect(await posted(INBOUND, { expectedReplyId: "reply-1" })).toBe("absent");
  });

  it("item 1: a sandbox record with NO replyId at all is NOT accepted", async () => {
    writeReply(sandboxRecord({ replyId: null }));
    expect(await posted(INBOUND, { expectedReplyId: "reply-1" })).toBe("absent");
  });

  it("the CLI's own local-send record (NO obligation ids) never satisfies an obligation", async () => {
    // The shape deliverToSandbox writes for a caller that supplies none — the
    // CLI's `tps mail send` bridge: id/from/to/body/timestamp/read/origin only.
    writeReply({
      id: "sandbox-record-1",
      from: AGENT,
      to: "flint",
      body: replyJson(),
      timestamp: new Date().toISOString(),
      read: false,
      origin: "host",
    });
    expect(await posted()).toBe("absent");
  });
});

// ── cli#389 round 4, item 1; per-agent since round 5 ───────────────────────
/**
 * The receipts dir is read by DIRECT PATH ONLY.
 *
 * The agent's receipts root grows with every non-local delivery and nothing but
 * the retention sweep ever takes a file out of it, so a scan that LISTS it
 * re-reads every retained receipt on every scan. The scan's dirs are therefore
 * split: `direct` dirs are probed once at `<obligationId>.json` and NEVER
 * listed, and only the route's `posted` dirs are listed.
 *
 * These assertions go through an INJECTED fs, never a clock: "the receipts dir
 * was not listed or parsed" is then a fact about the calls a scan makes.
 */
describe("cli#389 round 4 — the receipts dir is read by DIRECT PATH ONLY", () => {
  /** A receipt for some OTHER obligation — the kind the receipts dir accumulates. */
  function unrelatedReceipts(n: number, route = "remote-branch"): void {
    for (let i = 0; i < n; i++) {
      writeMetadataReceipt({
        replyId: `reply-${i}`,
        obligationId: `ob-unrelated-${i}`,
        replyToId: `inbound-${i}`,
        route,
        ts: new Date().toISOString(),
      });
    }
  }

  it("item 1: 1,000 unrelated receipts + one unreadable file are neither listed nor parsed", async () => {
    unrelatedReceipts(1000);
    // ONE unreadable file: it cannot be read as a receipt — the shape
    // drainOutbox quarantines as `.malformed-`, which the posted-file scan
    // reports as a FAILURE. In the receipts dir it must be invisible.
    writeFileSync(join(receiptsRoot(), ".malformed-cannot-be-read.json"), "{ not json ", "utf-8");

    const listed: string[] = [];
    const read: string[] = [];
    const spyFs = {
      existsSync: (p: string) => realExistsSync(p),
      readdirSync: (p: string) => {
        listed.push(p);
        return realReaddirSync(p) as unknown as string[];
      },
      readFileSync: (p: string, enc: "utf-8") => {
        read.push(p);
        return readFileSync(p, enc);
      },
    };

    const s = await scan({ direct: [receiptsRoot()], posted: [dir] }, INBOUND, { fs: spyFs });

    // The 1,000 receipts and the unreadable file changed nothing: no receipt
    // for this obligation, and NOT a spurious `.malformed-` failure.
    expect(s.status).toBe("absent");
    // The receipts dir was never LISTED — only the route's posted dir was.
    expect(listed).toEqual([dir]);
    // …and no file in it was read: not one of the 1,000, and not the direct
    // path either (it does not exist for this obligation).
    expect(read.filter((p) => p.startsWith(receiptsRoot()))).toEqual([]);
  });

  it("item 1: this obligation's own receipt is still FOUND by its direct path, with no listing at all", async () => {
    writeMetadataReceipt(metadata({ route: "bridge" }));
    unrelatedReceipts(100, "bridge");

    const listed: string[] = [];
    const spyFs = {
      existsSync: (p: string) => realExistsSync(p),
      readdirSync: (p: string) => {
        listed.push(p);
        return realReaddirSync(p) as unknown as string[];
      },
      readFileSync: (p: string, enc: "utf-8") => readFileSync(p, enc),
    };

    const s = await scan({ direct: [receiptsRoot()], posted: [] }, INBOUND, { fs: spyFs });

    expect(s.status).toBe("found");
    expect(s.status === "found" && s.path).toBe(join(receiptsRoot(), `${OB_ID}.json`));
    expect(listed, "the direct path answers, so nothing is listed").toEqual([]);
  });
});

// ── cli#429: the SIGNED thread — a changed or stripped envelope thread is not a receipt ──

describe("receipt scan — cli#429 signed thread mode (real signatures)", () => {
  const signed = (thread = THREAD) => posted(thread, { threadMode: "signed" });

  it("wrapper AND the signed envelope carry the thread → found (positive control)", async () => {
    writeReply(reply({ replyToId: THREAD, body: replyJson({ replyToId: THREAD }) }));
    expect(await signed()).toBe("found");
  });

  it("the SIGNED envelope threads another message (wrapper still right) → NOT found", async () => {
    writeReply(reply({ replyToId: THREAD, body: replyJson({ replyToId: "a-different-thread" }) }));
    expect(await signed()).toBe("absent");
  });

  it("the signed envelope carries NO thread (wrapper still right) → NOT found", async () => {
    writeReply(reply({ replyToId: THREAD, body: replyJson() }));
    expect(await signed()).toBe("absent");
  });

  it("the envelope's thread was CHANGED after signing (signature broken) → NOT found", async () => {
    const env = JSON.parse(replyJson({ replyToId: "a-different-thread" }));
    env.replyToId = THREAD; // right thread, but the signature covered the old one
    writeReply(reply({ replyToId: THREAD, body: JSON.stringify(env) }));
    expect(await signed()).toBe("absent");
  });

  it("the WRAPPER's thread changed (envelope right) → NOT found", async () => {
    writeReply(reply({ replyToId: "a-different-thread", body: replyJson({ replyToId: THREAD }) }));
    expect(await signed()).toBe("absent");
  });

  it("the bridge sandbox record is held to the same signed thread", async () => {
    writeReply(sandboxRecord({ replyToId: THREAD, body: replyJson({ replyToId: "a-different-thread" }) }));
    expect(await signed()).toBe("absent");
    writeReply(sandboxRecord({ replyToId: THREAD, body: replyJson({ replyToId: THREAD }) }));
    expect(await signed()).toBe("found");
  });

  it("the metadata receipt is held to the same signed thread", async () => {
    writeMetadataReceipt(metadata({ replyToId: THREAD, signedReply: replyJson({ replyToId: "a-different-thread" }) }));
    expect(await direct(THREAD, { threadMode: "signed" })).toBe("absent");
    writeMetadataReceipt(metadata({ replyToId: THREAD, signedReply: replyJson({ replyToId: THREAD }) }));
    expect(await direct(THREAD, { threadMode: "signed" })).toBe("found");
  });

  it("LEGACY mode (an obligation written before cli#429) keeps the wrapper-only THREAD check — and still verifies the signature", async () => {
    // Its reply carried the inbound RECORD id on the wrapper and nothing in the envelope.
    writeReply(reply({ replyToId: INBOUND, body: replyJson() }));
    expect(await posted(INBOUND, { threadMode: "legacy" })).toBe("found");
    writeReply(reply({ replyToId: INBOUND, body: replyJson({ unsigned: true }) }));
    expect(await posted(INBOUND, { threadMode: "legacy" })).toBe("absent");
  });

  it("receiptThread: a current record threads on its SIGNED envelope id; a pre-cli#429 record on its record id", () => {
    expect(receiptThread({ inboundId: INBOUND, inboundEnvelopeId: THREAD })).toEqual({ threadId: THREAD, mode: "signed" });
    expect(receiptThread({ inboundId: INBOUND })).toEqual({ threadId: INBOUND, mode: "legacy" });
  });
});
