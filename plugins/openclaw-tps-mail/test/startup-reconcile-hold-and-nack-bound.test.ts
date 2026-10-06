/**
 * Startup reconciliation (cli#500): the unresolved-record hold and the
 * owed-nack age bound. These cases compose the two calls in the order startup
 * uses them (reconcileTerminalCurStamps → sweepTerminalObligations with the
 * returned set).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileTerminalCurStamps } from "../src/index.js";
import { nackOwed, obligationsDir, readObligation, sweepTerminalObligations } from "../src/obligations.js";

const AGENT = "auditbot";
let mailDir: string;

const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function terminalRecord(inboundId: string, state: "acked" | "failed", ageDays: number, owesNack: boolean): string {
 const dir = obligationsDir(mailDir, AGENT);
 mkdirSync(dir, { recursive: true });
 const ts = daysAgo(ageDays);
 const p = join(dir, `${inboundId}.json`);
 writeFileSync(p, JSON.stringify({
 obligationId: `ob-${inboundId}`,
 inboundId,
 inboundTimestamp: ts,
 from: "sender",
 to: AGENT,
 accountId: "default",
 state,
 deadlineAt: null,
 attempts: 1,
 ...(state === "failed" ? { failure: "no-route" } : {}),
 ...(owesNack ? { nackPending: true } : {}),
 lastTransitionAt: ts,
 }, null, 2));
 return p;
}

beforeEach(() => { mailDir = mkdtempSync(join(tmpdir(), "tps-audit-500-")); });
afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

const quiet = { info: () => {}, warn: () => {} };

describe("startup reconciliation: the unresolved hold and the owed-nack age bound", () => {
 it("an aged owed nack is abandoned even when its inbound is in the unresolved set", () => {
 terminalRecord("owed-unresolved", "failed", 40, true);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, new Set(["owed-unresolved"]));
 expect(res.abandonedForNack, "past the 28-day hold the debt is abandoned").toBe(1);
 expect(nackOwed(readObligation(mailDir, AGENT, "owed-unresolved")), "so the startup retry stops").toBe(false);
 });

 it("startup composition: an aged owed nack whose cur/ record is gone is abandoned", () => {
 terminalRecord("owed-archived", "failed", 40, true);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true }); // cur/ exists; the record was archived
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.abandonedForNack).toBe(1);
 expect(nackOwed(readObligation(mailDir, AGENT, "owed-archived"))).toBe(false);
 });

 it("control (passes on main): with its stamped cur/ record present, the aged acked record is removed", () => {
 const p = terminalRecord("acked-present", "acked", 40, false);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 writeFileSync(join(mailDir, AGENT, "cur", "2026-01-01T00-00-00-000Z-acked-present.json"),
 JSON.stringify({ id: "acked-present", ackedAt: daysAgo(40), read: true }));
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.removed).toBe(1);
 expect(existsSync(p)).toBe(false);
 });

 // Adjacent to the audit finding (not raised by the auditor): an aged acked
 // record whose cur/ record is gone must still be removed by retention rather
 // than held as unresolved.
 it("adjacent: startup retention removes an aged acked obligation whose cur/ record is gone", () => {
 const p = terminalRecord("acked-archived", "acked", 40, false);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.removed).toBe(1);
 expect(existsSync(p)).toBe(false);
 });

 // cli#526: a gone cur/ record must not produce a read-failure warning on every
 // restart. The record survives both starts (so a per-start warning would fire
 // on both) and the warning count stays zero.
 it("no repeated restart warning for a gone cur/ record across two startup compositions", () => {
 const p = terminalRecord("acked-gone-warn", "acked", 40, false);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 const seen: string[] = [];
 const log = { info: () => {}, warn: (m: string) => seen.push(m) };
 for (let start = 0; start < 2; start++) {
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, log);
 sweepTerminalObligations(mailDir, AGENT, 60, log, Date.now(), 240, unresolved);
 }
 expect(existsSync(p), "the record is inside the 60-day retention, so it survived both starts").toBe(true);
 expect(seen.filter((m) => m.includes("stamp-reconcile-read-failed"))).toHaveLength(0);
 });
});
