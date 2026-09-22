/**
 * receipt-scan.test.ts — cli#398 round 2, item 3: pin EVERY field the receipt
 * scan checks, so the docblock cannot drift from the code again.
 *
 * `scanForReceipt` matches on the obligation marker, the accountId, the record
 * `from`, and the signed envelope's `from` — four fields, none of them a
 * signature. Each fixture below leaves three fields right and makes one wrong,
 * asserting the record is NOT accepted.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanForReceipt } from "../src/obligations.js";

const AGENT = "anvil";
const ACCOUNT = "default";
const OB_ID = "ob-1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tps-receipt-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A reply record with all four fields right; `over` spoils exactly one. */
function reply(over: Partial<{ accountId: string; from: string; envelopeFrom: string; marker: string }> = {}): any {
  return {
    id: "reply-1",
    to: "flint",
    from: over.from ?? AGENT,
    accountId: over.accountId ?? ACCOUNT,
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

describe("receipt scan — every checked field pinned", () => {
  it("all four fields right → found (positive control)", () => {
    writeReply(reply());
    expect(scanForReceipt([dir], OB_ID, AGENT, ACCOUNT).status).toBe("found");
  });

  it("right marker + WRONG accountId → NOT found", () => {
    writeReply(reply({ accountId: "some-other-account" }));
    expect(scanForReceipt([dir], OB_ID, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG record.from → NOT found", () => {
    writeReply(reply({ from: "someone-else" }));
    expect(scanForReceipt([dir], OB_ID, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("right marker + WRONG envelope.from (wrapper from matches) → NOT found", () => {
    writeReply(reply({ envelopeFrom: "someone-else" }));
    expect(scanForReceipt([dir], OB_ID, AGENT, ACCOUNT).status).toBe("absent");
  });

  it("WRONG marker (everything else right) → NOT found", () => {
    writeReply(reply({ marker: "ob-2" }));
    expect(scanForReceipt([dir], OB_ID, AGENT, ACCOUNT).status).toBe("absent");
  });
});
