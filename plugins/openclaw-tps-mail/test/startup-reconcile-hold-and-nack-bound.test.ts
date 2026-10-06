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
 it("successful aged nack release clears the debt for an unresolved inbound", () => {
 terminalRecord("owed-unresolved", "failed", 40, true);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, new Set(["owed-unresolved"]));
 expect(res.abandonedForNack).toBe(1);
 expect(nackOwed(readObligation(mailDir, AGENT, "owed-unresolved"))).toBe(false);
 });

 for (const held of [false, true]) {
 it(`failed nack release retains the owed record (unresolved=${held})`, () => {
 const id = "owed-write-failed";
 const p = terminalRecord(id, "failed", 40, true);
 const staging = join(obligationsDir(mailDir, AGENT), `.${id}.json.tmp`);
 // A directory at the staging path makes the release write fail for any user, root included.
 mkdirSync(staging);
 const seen: string[] = [];
 const log = { info: () => {}, warn: (m: string) => seen.push(m) };
 const unresolved = new Set(held ? [id] : []);
 try {
 const res = sweepTerminalObligations(mailDir, AGENT, 7, log, Date.now(), 28, unresolved);
 expect(existsSync(p)).toBe(true);
 expect(nackOwed(readObligation(mailDir, AGENT, id))).toBe(true);
 expect(res.removed).toBe(0);
 expect(res.abandonedForNack).toBe(0);
 expect(seen.some((m) => m.includes("obligation-write-failed") && /EISDIR/.test(m))).toBe(true);
 expect(seen.some((m) => m.includes("nack-release-failed") && m.includes(`ob-${id}`))).toBe(true);
 expect(seen.some((m) => m.includes("nack-abandoned") || m.includes("the debt is released"))).toBe(false);
 } finally {
 rmSync(staging, { recursive: true, force: true });
 }
 const retry = sweepTerminalObligations(mailDir, AGENT, 7, log, Date.now(), 28, unresolved);
 expect(retry.abandonedForNack).toBe(1);
 expect(nackOwed(readObligation(mailDir, AGENT, id))).toBe(false);
 expect(existsSync(p)).toBe(held);
 });
 }

 it("missing cur/ record: aged owed-nack release succeeds", () => {
 terminalRecord("owed-archived", "failed", 40, true);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.abandonedForNack).toBe(1);
 expect(nackOwed(readObligation(mailDir, AGENT, "owed-archived"))).toBe(false);
 });

 it("with its stamped cur/ record present, the aged acked record is removed", () => {
 const p = terminalRecord("acked-present", "acked", 40, false);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 writeFileSync(join(mailDir, AGENT, "cur", "2026-01-01T00-00-00-000Z-acked-present.json"),
 JSON.stringify({ id: "acked-present", ackedAt: daysAgo(40), read: true }));
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.removed).toBe(1);
 expect(existsSync(p)).toBe(false);
 });

 it("startup retention removes an aged acked obligation whose cur/ record is gone", () => {
 const p = terminalRecord("acked-archived", "acked", 40, false);
 mkdirSync(join(mailDir, AGENT, "cur"), { recursive: true });
 const unresolved = reconcileTerminalCurStamps(mailDir, AGENT, quiet);
 const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28, unresolved);
 expect(res.removed).toBe(1);
 expect(existsSync(p)).toBe(false);
 });

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
