/**
 * receipt-scan.test.ts — cli#398 round 2, item 3, extended for cli#389 round 3.
 *
 * TWO receipt forms and ONE rule: the receipt must name THIS obligation AND the
 * inbound it answers. Every field either form is checked on is pinned here, so
 * the docblock cannot drift from the code again.
 *
 * (1) METADATA (`~/.tps/receipts/<obligationId>.json`, cli#389 round 3): read by
 *     its DIRECT path — no directory parse — and accepted only when
 *     `obligationId` matches AND `replyToId` is the inbound this obligation is
 *     keyed on. That is what makes a REUSED obligation id safe: a receipt minted
 *     for another inbound (or an older reply) never satisfies it.
 * (2) POSTED FILE: matched on the obligation marker, the accountId, the record
 *     `from`, the signed envelope's `from`, and `replyToId`.
 *
 * The `replyToId` rows below are cli#389 round 3, item 3.
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

const receiptsRoot = (): string => join(home, ".tps", "receipts");

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
    // The wrapper body is the signed envelope JSON; envelopeFrom reads `.from`.
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

// ── cli#389 round 4, item 1 ─────────────────────────────────────────────────
/**
 * The shared receipts dir is read by DIRECT PATH ONLY.
 *
 * `~/.tps/receipts` grows with every non-local delivery and nothing but the
 * retention sweep ever takes a file out of it, so a scan that LISTS it re-reads
 * every retained receipt on every scan. The scan's dirs are therefore split:
 * `direct` dirs are probed once at `<obligationId>.json` and NEVER listed, and
 * only the route's `posted` dirs are listed.
 *
 * These assertions go through an INJECTED fs, never a clock: "the receipts dir
 * was not listed or parsed" is then a fact about the calls a scan makes.
 */
describe("cli#389 round 4 — the shared receipts dir is read by DIRECT PATH ONLY", () => {
  /** A receipt for some OTHER obligation — the kind the shared dir accumulates. */
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
    // reports as a FAILURE. In the shared receipts dir it must be invisible.
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

    const scan = scanForReceipt({ direct: [receiptsRoot()], posted: [dir] }, OB_ID, INBOUND, AGENT, ACCOUNT, spyFs);

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

    const scan = scanForReceipt({ direct: [receiptsRoot()], posted: [] }, OB_ID, INBOUND, AGENT, ACCOUNT, spyFs);

    expect(scan.status).toBe("found");
    expect(scan.status === "found" && scan.path).toBe(join(receiptsRoot(), `${OB_ID}.json`));
    expect(listed, "the direct path answers, so nothing is listed").toEqual([]);
  });
});
