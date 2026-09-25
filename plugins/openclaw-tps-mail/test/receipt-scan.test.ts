/**
 * receipt-scan.test.ts — cli#398 round 2, item 3, extended for cli#389 round 3.
 *
 * TWO receipt forms and ONE rule: the receipt must name THIS obligation AND the
 * inbound it answers. Every field either form is checked on is pinned here, so
 * the docblock cannot drift from the code again.
 *
 * (1) METADATA (`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json`,
 *     cli#389 round 3; per-agent since round 5): read by its DIRECT path — no
 *     directory parse — and accepted only when `obligationId` matches AND
 *     `replyToId` is the inbound this obligation is keyed on. That is what makes
 *     a REUSED obligation id safe: a receipt minted for another inbound (or an
 *     older reply) never satisfies it.
 * (2) POSTED FILE: matched on the obligation marker, the accountId, the record
 *     `from`, the sender the body's envelope CLAIMS, and `replyToId` — OR
 *     (cli#389 round 5, item 2) on the obligation ids `deliverToSandbox` writes
 *     into its reduced record, the record `from` and the sender that envelope
 *     CLAIMS. The scan does NOT verify a signature, and it does not claim to
 *     (cli#389 round 6, item 1): the envelope `from` is a string the scan reads,
 *     not an identity it proves.
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

import { scanForReceipt } from "../src/obligations.js";

const AGENT = "anvil";
const ACCOUNT = "default";
const OB_ID = "ob-1";
const INBOUND = "inbound-1";

/** The receipts root for a HOME. */
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

/** A reply record with all five fields right; `over` spoils exactly one. */
function reply(
  over: Partial<{ accountId: string; from: string; envelopeFrom: string; marker: string; replyToId: string }> = {},
): any {
  return {
    id: "reply-1",
    to: "flint",
    from: over.from ?? AGENT,
    accountId: over.accountId ?? ACCOUNT,
    replyToId: over.replyToId ?? INBOUND,
    // The wrapper body is the envelope JSON; envelopeFrom reads the sender it CLAIMS.
    body: JSON.stringify({ v: 1, from: over.envelopeFrom ?? AGENT, to: "flint", body: "the answer" }),
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

describe("receipt scan — the POSTED FILE, every checked field pinned", () => {
  it("all five fields right → found (positive control)", () => {
    writeReply(reply());
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("found");
  });

  it("right marker + WRONG accountId → NOT found", () => {
    writeReply(reply({ accountId: "some-other-account" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG record.from → NOT found", () => {
    writeReply(reply({ from: "someone-else" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG envelope.from (wrapper from matches) → NOT found", () => {
    writeReply(reply({ envelopeFrom: "someone-else" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("WRONG marker (everything else right) → NOT found", () => {
    writeReply(reply({ marker: "ob-2" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("item 3: the RIGHT obligation id but ANOTHER inbound (replyToId) → NOT found", () => {
    writeReply(reply({ replyToId: "some-other-inbound" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });
});

describe("receipt scan — the METADATA receipt, read by its DIRECT path", () => {
  it("matching obligation id + inbound → found (positive control)", () => {
    writeMetadataReceipt({
      replyId: "reply-1",
      obligationId: OB_ID,
      replyToId: INBOUND,
      route: "remote-branch",
      branchId: "tps-rockit",
      ts: new Date().toISOString(),
    });
    const scan = scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT);
    expect(scan.status).toBe("found");
    expect(scan.status === "found" && scan.path).toBe(join(receiptsRoot(), `${OB_ID}.json`));
  });

  it("item 3: the RIGHT obligation id but ANOTHER replyToId → NOT found", () => {
    writeMetadataReceipt({
      replyId: "reply-1",
      obligationId: OB_ID,
      replyToId: "some-other-inbound",
      route: "bridge",
      ts: new Date().toISOString(),
    });
    expect(scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("item 1: the RIGHT obligation id + inbound but ANOTHER replyId than the record knows → NOT found", () => {
    writeMetadataReceipt({
      replyId: "reply-OTHER",
      obligationId: OB_ID,
      replyToId: INBOUND,
      route: "bridge",
      ts: new Date().toISOString(),
    });
    expect(scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT, "reply-1").status).toBe(
      "absent",
    );
    // …and with the matching replyId it is found.
    writeMetadataReceipt({
      replyId: "reply-1",
      obligationId: OB_ID,
      replyToId: INBOUND,
      route: "bridge",
      ts: new Date().toISOString(),
    });
    expect(scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT, "reply-1").status).toBe(
      "found",
    );
  });

  it("a receipt for ANOTHER obligation id in the same dir does not satisfy this one", () => {
    writeMetadataReceipt({
      replyId: "reply-2",
      obligationId: "ob-2",
      replyToId: INBOUND,
      route: "bridge",
      ts: new Date().toISOString(),
    });
    expect(scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("a metadata receipt NAMES its fields — and holds NO body", () => {
    const path = writeMetadataReceipt({
      replyId: "reply-1",
      obligationId: OB_ID,
      replyToId: INBOUND,
      route: "remote-branch",
      ts: new Date().toISOString(),
    });
    const raw = readFileSync(path, "utf-8");
    // The body text this suite's fixtures carry never reaches a receipt.
    expect(raw.includes("the answer")).toBe(false);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["obligationId", "replyId", "replyToId", "route", "ts"]);
  });
});

describe("receipt scan — the BRIDGE SANDBOX RECORD (cli#389 round 5, item 2)", () => {
  /**
   * The reduced record `deliverToSandbox` writes when the caller gives it the
   * obligation ids. It has NO headers and NO accountId — so of the posted-file
   * pins only `from`, the sender its envelope CLAIMS and the ids can be checked.
   */
  function sandboxRecord(
    over: Partial<{ obligationId: string; replyToId: string; from: string; envelopeFrom: string; replyId: string | null }> = {},
  ): any {
    const rec: any = {
      id: "sandbox-record-1",
      from: over.from ?? AGENT,
      to: "flint",
      body: JSON.stringify({ v: 1, from: over.envelopeFrom ?? AGENT, to: "flint", body: "the answer" }),
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

  it("the obligation ids + the agent's envelope (its CLAIMED sender) → found (positive control)", () => {
    writeReply(sandboxRecord());
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("found");
  });

  it("a WRONG obligationId → NOT found", () => {
    writeReply(sandboxRecord({ obligationId: "ob-2" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("the RIGHT obligation id but ANOTHER inbound (replyToId) → NOT found", () => {
    writeReply(sandboxRecord({ replyToId: "some-other-inbound" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("a WRONG record.from → NOT found", () => {
    writeReply(sandboxRecord({ from: "someone-else" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("a body whose envelope does NOT CLAIM this agent → NOT found", () => {
    writeReply(sandboxRecord({ envelopeFrom: "someone-else" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  // ── cli#389 round 6, item 1: the reply binding ────────────────────────────

  it("item 1: the obligation record knows the reply → a sandbox record with the SAME replyId is found", () => {
    writeReply(sandboxRecord({ replyId: "reply-1" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, "reply-1").status).toBe(
      "found",
    );
  });

  it("item 1: a sandbox record with correct obligation + inbound ids but a DIFFERENT replyId is NOT accepted", () => {
    writeReply(sandboxRecord({ replyId: "reply-2" }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, "reply-1").status).toBe(
      "absent",
    );
  });

  it("item 1: a sandbox record with NO replyId at all is NOT accepted", () => {
    writeReply(sandboxRecord({ replyId: null }));
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, "reply-1").status).toBe(
      "absent",
    );
  });

  it("the CLI's own local-send record (NO obligation ids) never satisfies an obligation", () => {
    // The shape deliverToSandbox writes for a caller that supplies none — the
    // CLI's `tps mail send` bridge: id/from/to/body/timestamp/read/origin only.
    writeReply({
      id: "sandbox-record-1",
      from: AGENT,
      to: "flint",
      body: JSON.stringify({ v: 1, from: AGENT, to: "flint", body: "the answer" }),
      timestamp: new Date().toISOString(),
      read: false,
      origin: "host",
    });
    expect(scanForReceipt({ direct: [], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
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

  it("item 1: 1,000 unrelated receipts + one unreadable file are neither listed nor parsed", () => {
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

    const scan = scanForReceipt({ direct: [receiptsRoot()], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, undefined, spyFs);

    // The 1,000 receipts and the unreadable file changed nothing: no receipt
    // for this obligation, and NOT a spurious `.malformed-` failure.
    expect(scan.status).toBe("absent");
    // The receipts dir was never LISTED — only the route's posted dir was.
    expect(listed).toEqual([dir]);
    // …and no file in it was read: not one of the 1,000, and not the direct
    // path either (it does not exist for this obligation).
    expect(read.filter((p) => p.startsWith(receiptsRoot()))).toEqual([]);
  });

  it("item 1: this obligation's own receipt is still FOUND by its direct path, with no listing at all", () => {
    writeMetadataReceipt({
      replyId: "reply-1",
      obligationId: OB_ID,
      replyToId: INBOUND,
      route: "bridge",
      ts: new Date().toISOString(),
    });
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

    const scan = scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT, undefined, spyFs);

    expect(scan.status).toBe("found");
    expect(scan.status === "found" && scan.path).toBe(join(receiptsRoot(), `${OB_ID}.json`));
    expect(listed, "the direct path answers, so nothing is listed").toEqual([]);
  });
});
