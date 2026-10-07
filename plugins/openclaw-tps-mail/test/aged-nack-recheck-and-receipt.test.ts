import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nackOwed,
  obligationsDir,
  readObligation,
  receiptPath,
  sweepTerminalObligations,
  writeReceipt,
} from "../src/obligations.js";

const AGENT = "auditbot";
const DAY_MS = 24 * 60 * 60 * 1000;
let mailDir: string;

const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

interface RecordOpts {
  obligationId: string;
  /** Defaults to the file name. A value that differs from the file name makes
   *  the sweep's read (by file name) and the release's re-read (by this field)
   *  two independent reads — the seam this file uses to inject a rewrite. */
  inboundId?: string;
  ageDays: number;
  owesNack?: boolean;
}

function writeRecord(name: string, opts: RecordOpts): string {
  const dir = obligationsDir(mailDir, AGENT);
  mkdirSync(dir, { recursive: true });
  const ts = daysAgo(opts.ageDays);
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({
    obligationId: opts.obligationId,
    inboundId: opts.inboundId ?? name,
    inboundTimestamp: ts,
    from: "sender",
    to: AGENT,
    accountId: "default",
    state: "failed",
    deadlineAt: null,
    attempts: 1,
    failure: "no-route",
    ...(opts.owesNack ? { nackPending: true } : {}),
    lastTransitionAt: ts,
  }, null, 2));
  return p;
}

function writeReceiptFor(obligationId: string, ageDays: number): string {
  writeReceipt(mailDir, AGENT, {
    replyId: `reply-${obligationId}`,
    obligationId,
    replyToId: `thread-${obligationId}`,
    route: "local",
    ts: daysAgo(ageDays),
    signedReply: "{}",
  });
  return receiptPath(mailDir, AGENT, obligationId);
}

beforeEach(() => { mailDir = mkdtempSync(join(tmpdir(), "tps-audit-533-")); });
afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

const quiet = { info: () => {}, warn: () => {} };

describe("the aged-nack release re-checks the record it re-read", () => {
  it("skips the release when the record now carries a fresh debt", () => {
    // The sweep's snapshot read sees an AGED debt for inbound "fresh": the file
    // it reads carries inboundId "fresh" and a 40-day-old transition. The
    // release re-reads by that inboundId, so "fresh.json" is the record as it
    // stands NOW — rewritten to a FRESH debt (a transition inside the window).
    const freshPath = writeRecord("fresh", { obligationId: "ob-fresh", ageDays: 0, owesNack: true });
    writeRecord("stale-snapshot", { obligationId: "ob-fresh", inboundId: "fresh", ageDays: 40, owesNack: true });

    // nackHoldDays = 28, so the 40-day snapshot read is past the hold window.
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28);

    expect(res.abandonedForNack).toBe(0);
    expect(existsSync(freshPath)).toBe(true);
    const kept = readObligation(mailDir, AGENT, "fresh");
    expect(nackOwed(kept)).toBe(true);
    expect(kept?.nackAbandonedAt).toBeUndefined();
  });
});

describe("the metadata receipt of a record held for its owed nack", () => {
  it("is kept while the record is held, and goes when the obligation is removed", () => {
    const recPath = writeRecord("owed-held", { obligationId: "ob-held", ageDays: 40, owesNack: true });
    const rPath = writeReceiptFor("ob-held", 40);

    // nackHoldDays = 60: the 40-day record is INSIDE the hold window, so it is
    // held for its nack and its receipt is retained with it.
    let res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 60);
    expect(res.heldForNack).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(recPath)).toBe(true);
    expect(existsSync(rPath)).toBe(true);

    // nackHoldDays = 28: the debt is now past the hold window — abandoned, then
    // the record ages out of retention and the receipt goes with it.
    res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28);
    expect(res.abandonedForNack).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.receiptsRemoved).toBe(1);
    expect(existsSync(recPath)).toBe(false);
    expect(existsSync(rPath)).toBe(false);
  });
});
