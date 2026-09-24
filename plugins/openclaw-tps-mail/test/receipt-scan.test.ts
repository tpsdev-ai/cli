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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("found");
  });

  it("right marker + WRONG accountId → NOT found", () => {
    writeReply(reply({ accountId: "some-other-account" }));
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG record.from → NOT found", () => {
    writeReply(reply({ from: "someone-else" }));
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG envelope.from (wrapper from matches) → NOT found", () => {
    writeReply(reply({ envelopeFrom: "someone-else" }));
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("WRONG marker (everything else right) → NOT found", () => {
    writeReply(reply({ marker: "ob-2" }));
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("item 3: the RIGHT obligation id but ANOTHER inbound (replyToId) → NOT found", () => {
    writeReply(reply({ replyToId: "some-other-inbound" }));
    expect(scanForReceipt([dir], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
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
    const scan = scanForReceipt([receiptsRoot()], OB_ID, INBOUND, AGENT, ACCOUNT);
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
    expect(scanForReceipt([receiptsRoot()], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("a receipt for ANOTHER obligation id in the same dir does not satisfy this one", () => {
    writeMetadataReceipt({
      replyId: "reply-2",
      obligationId: "ob-2",
      replyToId: INBOUND,
      route: "bridge",
      ts: new Date().toISOString(),
    });
    expect(scanForReceipt([receiptsRoot()], OB_ID, INBOUND, AGENT, ACCOUNT).status).toBe("absent");
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
