import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFs = { ...fs };
let rewriteAfterRead: { path: string; run: () => void } | undefined;
let recordReads = 0;
mock.module("node:fs", () => ({
  ...realFs,
  readFileSync: (...args: any[]) => {
    const result = (realFs.readFileSync as any)(...args);
    if (args[0] === rewriteAfterRead?.path && ++recordReads === 2) rewriteAfterRead.run();
    return result;
  },
}));
const {
  abandonOwedNack, createObligation, markNackSent, transitionObligation, writeObligation,
  nackOwed, obligationsDir, readObligation, receiptPath,
  sweepTerminalObligations, writeReceipt,
} = await import("../src/obligations.js");

function waitFor(path: string): void {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { realFs.readFileSync(path); return; } catch {}
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const AGENT = "auditbot";
const DAY_MS = 24 * 60 * 60 * 1000;
let mailDir: string;

const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

interface RecordOpts {
  obligationId: string;
  inboundId?: string;
  state?: "failed" | "pending";
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
    state: opts.state ?? "failed",
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
afterEach(() => { rewriteAfterRead = undefined; recordReads = 0; rmSync(mailDir, { recursive: true, force: true }); });

const quiet = { info: () => {}, warn: () => {} };

describe("owed-nack retention", () => {
  it("skips a locked store while a competing writer refreshes one record", async () => {
    const path = writeRecord("debt", { obligationId: "ob-debt", ageDays: 40, owesNack: true });
    const ready = join(mailDir, "ready");
    const go = join(mailDir, "go");
    const landed = join(mailDir, "landed");
    const done = join(mailDir, "done");
    const writer = join(mailDir, "writer.mjs");
    realFs.writeFileSync(writer, `
      import { readFileSync, writeFileSync } from "node:fs";
      import { updateExistingRecord } from ${JSON.stringify(import.meta.resolve("@tpsdev-ai/cli/utils/mail"))};
      const wait = (p) => {
        const end = Date.now() + 10000;
        for (;;) {
          try { readFileSync(p); return; } catch {}
          if (Date.now() >= end) throw new Error("writer wait timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      };
      updateExistingRecord(${JSON.stringify(path)}, (record) => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        wait(${JSON.stringify(go)});
        return { ...record, lastTransitionAt: new Date().toISOString(), nackPending: true };
      }, { afterWrite: () => {
        writeFileSync(${JSON.stringify(landed)}, "landed");
        wait(${JSON.stringify(done)});
      } });
    `);
    const child = spawn(process.execPath, [writer], { stdio: ["ignore", "ignore", "inherit"] });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const refresh = () => { realFs.writeFileSync(go, "go"); waitFor(landed); };
    try {
      waitFor(ready);
      rewriteAfterRead = { path, run: refresh };
      const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28);
      rewriteAfterRead = undefined;
      refresh();
      realFs.writeFileSync(done, "done");
      expect(await exited).toBe(0);
      expect(res.abandonedForNack).toBe(0);
      expect(res.removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      const kept = readObligation(mailDir, AGENT, "debt");
      expect(nackOwed(kept)).toBe(true);
      expect(kept?.nackAbandonedAt).toBeUndefined();
      expect(Date.parse(kept!.lastTransitionAt!)).toBeGreaterThan(Date.now() - DAY_MS);
    } finally {
      realFs.writeFileSync(go, "go");
      realFs.writeFileSync(done, "done");
      child.kill();
      await exited;
    }
  });

  it("uses the mailbox lock for every obligation writer", async () => {
    const { acquireMailLockSync } = await import("@tpsdev-ai/agent");
    const path = writeRecord("writer", { obligationId: "ob-writer", ageDays: 40, owesNack: true });
    const current = readObligation(mailDir, AGENT, "writer")!;
    const bytes = realFs.readFileSync(path, "utf8");
    const lock = acquireMailLockSync(join(mailDir, AGENT));
    expect(lock).not.toBeNull();
    try {
      expect(() => writeObligation(mailDir, AGENT, { ...current, state: "pending" })).toThrow("nested acquisition");
      expect(() => createObligation(mailDir, AGENT, () => current)).toThrow("nested acquisition");
      expect(() => transitionObligation(mailDir, AGENT, "writer", "acked")).toThrow("nested acquisition");
      expect(markNackSent(mailDir, AGENT, "writer", quiet)).toBe(false);
      expect(abandonOwedNack(mailDir, AGENT, "writer", quiet)).toBe(false);
      expect(() => writeReceiptFor("ob-writer", 40)).toThrow("nested acquisition");
      expect(realFs.readFileSync(path, "utf8")).toBe(bytes);
    } finally { lock?.release(); }
  });

  it("keeps a receipt shared by a held record and a terminal record", () => {
    writeRecord("held", { obligationId: "ob-shared", ageDays: 40, owesNack: true });
    writeRecord("terminal", { obligationId: "ob-shared", ageDays: 40 });
    const path = writeReceiptFor("ob-shared", 40);
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 60);
    expect(res.heldForNack).toBe(1);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps an ambiguous receipt when both claimants are terminal", () => {
    writeRecord("first", { obligationId: "ob-shared", ageDays: 40 });
    writeRecord("second", { obligationId: "ob-shared", ageDays: 40 });
    const path = writeReceiptFor("ob-shared", 40);
    expect(sweepTerminalObligations(mailDir, AGENT, 7, quiet).receiptsRemoved).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a record whose inbound id differs from its filename", () => {
    const path = writeRecord("mismatch", { obligationId: "ob-mismatch", inboundId: "other", ageDays: 40 });
    const receipt = writeReceiptFor("ob-mismatch", 40);
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.unreadable).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(receipt)).toBe(true);
  });

  it("validates the hold setting with Ajv against the shipped manifest", async () => {
    const require = createRequire(import.meta.url);
    const Ajv = createRequire(require.resolve("openclaw/package.json"))("ajv");
    const manifest = JSON.parse(realFs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const validate = new Ajv().compile(manifest.configSchema);
    const config = { obligationNackHoldMultiple: 8 };
    expect(validate(config)).toBe(true);
    expect(validate({ obligationNackHoldMultiple: 0.5 })).toBe(false);
    const { resolveObligationNackHoldDays } = await import("../src/index.js");
    const hold = resolveObligationNackHoldDays(7, config, {});
    const path = writeRecord("configured", { obligationId: "ob-configured", ageDays: 40, owesNack: true });
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), hold);
    expect(res.heldForNack).toBe(1);
    expect(res.abandonedForNack).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("ages debt from inboundTimestamp when lastTransitionAt is absent", () => {
    const path = writeRecord("legacy", { obligationId: "ob-legacy", ageDays: 40, owesNack: true });
    const receipt = writeReceiptFor("ob-legacy", 40);
    const record = JSON.parse(realFs.readFileSync(path, "utf8"));
    delete record.lastTransitionAt;
    realFs.writeFileSync(path, JSON.stringify(record));
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.abandonedForNack).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.receiptsRemoved).toBe(1);
    expect(() => realFs.readFileSync(path)).toThrow();
    expect(() => realFs.readFileSync(receipt)).toThrow();
  });

  for (const timestamp of [null, 123, false, {}, []]) {
    it(`keeps debt and receipt with lastTransitionAt ${JSON.stringify(timestamp)}`, () => {
      const id = "unageable";
      const path = writeRecord(id, { obligationId: "ob-unageable", ageDays: 40, owesNack: true });
      const receipt = writeReceiptFor("ob-unageable", 40);
      const record = JSON.parse(realFs.readFileSync(path, "utf8"));
      record.lastTransitionAt = timestamp;
      realFs.writeFileSync(path, JSON.stringify(record));
      const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
      expect(res.abandonedForNack).toBe(0);
      expect(res.removed).toBe(0);
      expect(res.receiptsRemoved).toBe(0);
      const kept = JSON.parse(realFs.readFileSync(path, "utf8"));
      expect(kept.lastTransitionAt).toEqual(timestamp);
      expect(kept.nackAbandonedAt).toBeUndefined();
      expect(nackOwed(kept)).toBe(true);
      expect(JSON.parse(realFs.readFileSync(receipt, "utf8")).obligationId).toBe("ob-unageable");
    });
  }

  it("keeps debt and receipt after an unparseable transition or a failed release write", () => {
    for (const fault of ["timestamp", "write"]) {
      const id = `fault-${fault}`;
      const path = writeRecord(id, { obligationId: `ob-${id}`, ageDays: 40, owesNack: true });
      const receipt = writeReceiptFor(`ob-${id}`, 40);
      if (fault === "write") mkdirSync(join(obligationsDir(mailDir, AGENT), `.${id}.json.tmp`));
      else {
        const record = JSON.parse(realFs.readFileSync(path, "utf8"));
        record.lastTransitionAt = "invalid";
        realFs.writeFileSync(path, JSON.stringify(record));
      }
      const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
      expect(res.abandonedForNack).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(receipt)).toBe(true);
      expect(nackOwed(readObligation(mailDir, AGENT, id))).toBe(true);
    }
  });
});

describe("the metadata receipt of a record held for its owed nack", () => {
  it("is kept while the record is held, and goes when the obligation is removed", () => {
    const recPath = writeRecord("owed-held", { obligationId: "ob-held", ageDays: 40, owesNack: true });
    const rPath = writeReceiptFor("ob-held", 40);

    let res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 60);
    expect(res.heldForNack).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(recPath)).toBe(true);
    expect(existsSync(rPath)).toBe(true);

    res = sweepTerminalObligations(mailDir, AGENT, 7, quiet, Date.now(), 28);
    expect(res.abandonedForNack).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.receiptsRemoved).toBe(1);
    expect(existsSync(recPath)).toBe(false);
    expect(existsSync(rPath)).toBe(false);
  });
});
