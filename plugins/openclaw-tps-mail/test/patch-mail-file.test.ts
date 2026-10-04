import { afterAll, afterEach, describe, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFs = { ...fs };
let removeAfterRead: string | undefined;
let readFailure: string | undefined;
let readsUntilFailure = 1;
let listFailure: string | undefined;
let stampOnRead: { path: string; count: number } | undefined;
let readsBeforeRemoval = 1;
let uncodedWriteFailure = false;
let scratchErrorCode: string | undefined;
let renameFailure: string | undefined;
let replaceIdentity = false;
mock.module("node:fs", () => ({
  ...realFs,
  readdirSync: (...args: any[]) => {
    if (args[0] === listFailure) throw Object.assign(new Error("injected list failure"), { code: "EACCES" });
    return (realFs.readdirSync as any)(...args);
  },
  renameSync: (...args: any[]) => {
    if (args[1] === renameFailure) throw Object.assign(new Error("injected rename failure"), { code: "EACCES" });
    return (realFs.renameSync as any)(...args);
  },
  openSync: (...args: any[]) => {
    if (uncodedWriteFailure && String(args[0]).includes(".ack-")) throw new Error("injected write failure");
    if (scratchErrorCode && String(args[0]).includes(".ack-")) throw Object.assign(new Error("injected scratch failure"), { code: scratchErrorCode, path: args[0] });
    return (realFs.openSync as any)(...args);
  },
  readFileSync: (...args: any[]) => {
    if (args[0] === readFailure && --readsUntilFailure <= 0) throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
    const result = (realFs.readFileSync as any)(...args);
    if (stampOnRead?.path === args[0] && --stampOnRead.count === 0) {
      const record = JSON.parse(String(result));
      if (replaceIdentity) record.id = "replacement";
      record.ackedAt = "concurrent-ack";
      record.nackedAt = "concurrent-nack";
      realFs.writeFileSync(stampOnRead.path, JSON.stringify(record));
      stampOnRead = undefined;
    }
    if (args[0] === removeAfterRead && --readsBeforeRemoval === 0) {
      realFs.unlinkSync(removeAfterRead!);
      removeAfterRead = undefined;
    }
    return result;
  },
}));

const { acquireMailLockSync, mailLockPath } = await import("@tpsdev-ai/agent");
const { patchMailFile, reconcileTerminalCurStamps } = await import("../src/index.js");
const { sweepTerminalObligations } = await import("../src/obligations.js");
const root = realFs.mkdtempSync(join(tmpdir(), "patch-mail-"));
const path = join(root, "record.json");

afterEach(() => {
  removeAfterRead = undefined;
  readsBeforeRemoval = readsUntilFailure = 1;
  readFailure = listFailure = undefined;
  stampOnRead = undefined;
  uncodedWriteFailure = replaceIdentity = false;
  scratchErrorCode = undefined;
  renameFailure = undefined;
  realFs.rmSync(join(root, "anvil"), { recursive: true, force: true });
  realFs.rmSync(path, { force: true });
});

afterAll(() => realFs.rmSync(root, { recursive: true, force: true }));

describe("patchMailFile", () => {
  test("a nested lock failure names the lock path", () => {
    const f = terminalFixture("acked");
    const lock = acquireMailLockSync(join(root, "anvil"))!;
    try {
      expect(patchMailFile(f.curPath, { ackedAt: "done" }, "ackedAt", "inbound")).toMatchObject({ ok: false, reason: "write-failed", path: mailLockPath(join(root, "anvil")) });
    } finally {
      lock.release();
    }
  });

  test("a lock timeout names the lock path", () => {
    const f = terminalFixture("acked");
    const lockPath = mailLockPath(join(root, "anvil"));
    realFs.mkdirSync(lockPath);
    expect(patchMailFile(f.curPath, { ackedAt: "done" }, "ackedAt", "inbound")).toMatchObject({ ok: false, reason: "write-failed", path: lockPath });
  });

  for (const code of ["EACCES", "ENOENT"]) {
    test(`a scratch ${code} failure names the target path and preserves the record`, () => {
      const f = terminalFixture("acked");
      scratchErrorCode = code;
      const result = patchMailFile(f.curPath, { ackedAt: "done" }, "ackedAt", "inbound");
      expect(result).toMatchObject({ ok: false, reason: "write-failed", code });
      if (result.ok) throw new Error("expected scratch failure");
      expect(result.path).toBe(f.curPath);
      f.reconcile();
      expect(f.logs[0]).toBe(`tps-mail: ack-stamp-reconcile-failed: inbound actor=anvil path=${f.curPath} code=${code}; obligation retained; resolve the failure and restart the account`);
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8")).ackedAt).toBeUndefined();
    });
  }

  test("patches an existing record", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    expect(patchMailFile(path, { read: true }, undefined, "inbound")).toEqual({ ok: true });
    expect(JSON.parse(realFs.readFileSync(path, "utf-8"))).toEqual({ id: "inbound", body: "hello", read: true });
  });

  test("reports a missing record without creating it", () => {
    expect(patchMailFile(path, { read: true }, undefined, "inbound")).toMatchObject({ ok: false, reason: "record-missing" });
    expect(realFs.existsSync(path)).toBe(false);
  });

  test("reports a record removed after the read without recreating it", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    removeAfterRead = path;
    expect(patchMailFile(path, { ackedAt: "receipt", read: true }, "ackedAt", "inbound")).toMatchObject({ ok: false, reason: "record-missing" });
    expect(removeAfterRead).toBeUndefined();
    expect(realFs.existsSync(path)).toBe(false);
  });
});


function terminalFixture(state: "acked" | "failed") {
  const obligationDir = join(root, "anvil", ".obligations");
  const curDir = join(root, "anvil", "cur");
  realFs.mkdirSync(obligationDir, { recursive: true });
  realFs.mkdirSync(curDir, { recursive: true });
  const obligationPath = join(obligationDir, "inbound.json");
  const curPath = join(curDir, "timestamp-inbound.json");
  realFs.writeFileSync(obligationPath, JSON.stringify({ obligationId: "ob-inbound", inboundId: "inbound", state, failure: "empty", lastTransitionAt: new Date(0).toISOString() }));
  realFs.writeFileSync(curPath, JSON.stringify({ id: "inbound", body: "hello" }));
  const logs: string[] = [];
  const reconcile = () => reconcileTerminalCurStamps(root, "anvil", { warn: (message: string) => logs.push(message) });
  return { obligationDir, obligationPath, curDir, curPath, logs, reconcile };
}

describe("terminal stamp reconciliation", () => {
  for (const state of ["acked", "failed"] as const) {
    const kind = state === "acked" ? "ack" : "nack";
    const key = state === "acked" ? "ackedAt" : "nackedAt";

    test(`${kind}: a record disappearing during the locked write is reported`, () => {
      const f = terminalFixture(state);
      removeAfterRead = f.curPath;
      readsBeforeRemoval = 3;
      f.reconcile();
      expect(removeAfterRead).toBeUndefined();
      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]).toContain(`${kind}-stamp-reconcile-failed: inbound actor=anvil path=${f.curPath} code=ENOENT`);
      expect(f.logs[0]).toContain("obligation retained; resolve the failure and restart the account");
      expect(realFs.existsSync(f.curPath)).toBe(false);
      expect(JSON.parse(realFs.readFileSync(f.obligationPath, "utf8")).state).toBe(state);
    });

    test(`${kind}: an uncoded write failure is reported and the next run can stamp`, () => {
      const f = terminalFixture(state);
      uncodedWriteFailure = true;
      f.reconcile();
      expect(f.logs[0]).toContain(`actor=anvil path=${f.curPath}`);
      expect(f.logs[0]).toContain("obligation retained; resolve the failure and restart the account");
      uncodedWriteFailure = false;
      f.reconcile();
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[key]).toBeDefined();
    });

    test(`${kind}: a second successful reconciliation preserves the stamp`, () => {
      const f = terminalFixture(state);
      f.reconcile();
      const bytes = realFs.readFileSync(f.curPath, "utf8");
      const stat = realFs.statSync(f.curPath);
      f.reconcile();
      expect(realFs.readFileSync(f.curPath, "utf8")).toBe(bytes);
      expect(realFs.statSync(f.curPath).mtimeMs).toBe(stat.mtimeMs);
      expect(realFs.statSync(f.curPath).ino).toBe(stat.ino);
      expect(f.logs).toEqual([]);
    });

    test(`${kind}: a concurrent stamp between the precheck and lock is preserved`, () => {
      const f = terminalFixture(state);
      stampOnRead = { path: f.curPath, count: 2 };
      f.reconcile();
      expect(stampOnRead).toBeUndefined();
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[key]).toBe(`concurrent-${kind}`);
    });
  }

  for (const stage of ["cur-read", "cur-reread"] as const) {
    test(`${stage}: a read failure is diagnosed and remains recoverable`, () => {
      const f = terminalFixture("acked");
      const target = f.curPath;
      readFailure = target;
      if (stage === "cur-reread") readsUntilFailure = 2;
      f.reconcile();
      expect(f.logs[0]).toContain("stamp-reconcile-read-failed");
      expect(f.logs[0]).toContain("actor=anvil");
      expect(f.logs[0]).toContain(`path=${target} code=EACCES`);
      expect(f.logs[0]).toContain("resolve the failure and restart the account");
      listFailure = readFailure = undefined;
      f.reconcile();
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8")).ackedAt).toBeDefined();
    });
  }

  test("an absent obligation directory has no read failure", () => {
    const logs: string[] = [];
    reconcileTerminalCurStamps(root, "anvil", { warn: (m: string) => logs.push(m) });
    expect(logs).toEqual([]);
  });

});

for (const state of ["acked", "failed"] as const) {
  for (const stage of ["cur-lookup-read", "cur-reread", "locked-read", "stamp-write", "stamp-rename", "identity-change"] as const) {
    test(`${state}: ${stage} holds an aged timestamped inbound and continues healthy records`, () => {
      const f = terminalFixture(state);
      if (stage.endsWith("read")) {
        readFailure = f.curPath;
        readsUntilFailure = stage === "cur-reread" ? 2 : stage === "locked-read" ? 3 : 1;
      }
      if (stage === "stamp-write") uncodedWriteFailure = true;
      if (stage === "stamp-rename") renameFailure = f.curPath;
      if (stage === "identity-change") {
        replaceIdentity = true;
        stampOnRead = { path: f.curPath, count: 2 };
      }
      const bytes = realFs.readFileSync(f.obligationPath, "utf8");
      const unresolved = f.reconcile();
      expect(unresolved.has("inbound")).toBe(true);
      const receiptDir = join(f.obligationDir, "receipts");
      realFs.mkdirSync(receiptDir);
      const receiptPath = join(receiptDir, "ob-inbound.json");
      realFs.writeFileSync(receiptPath, JSON.stringify({ obligationId: "ob-inbound", ts: new Date(0).toISOString() }));
      realFs.writeFileSync(join(f.obligationDir, "healthy.json"), JSON.stringify({ inboundId: "healthy", obligationId: "ob-healthy", state: "acked", lastTransitionAt: new Date(0).toISOString() }));
      listFailure = readFailure = renameFailure = undefined;
      uncodedWriteFailure = false;
      realFs.writeFileSync(join(f.curDir, "timestamp-healthy.json"), JSON.stringify({ id: "healthy", ackedAt: "done" }));
      sweepTerminalObligations(root, "anvil", 7, { warn: (m) => f.logs.push(m) }, Date.now(), 28, unresolved);
      expect(realFs.readFileSync(f.obligationPath, "utf8")).toBe(bytes);
      expect(realFs.existsSync(receiptPath)).toBe(true);
      expect(realFs.existsSync(join(f.obligationDir, "healthy.json"))).toBe(false);
      expect(f.logs.filter((m) => m.includes("actor=anvil"))).toHaveLength(1);
      expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain(`actor=anvil`);
      expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain("restart the account");
      replaceIdentity = false;
      if (stage === "identity-change") realFs.writeFileSync(f.curPath, JSON.stringify({ id: "inbound" }));
      expect(f.reconcile().size).toBe(0);
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[state === "acked" ? "ackedAt" : "nackedAt"]).toBeDefined();
    });
  }
}

for (const presence of ["missing", "unreadable"] as const) {
  test(`stamp reconciliation reports ${presence} obligation state`, () => {
    const f = terminalFixture("acked");
    const record = JSON.parse(realFs.readFileSync(f.obligationPath, "utf8"));
    if (presence === "missing") realFs.unlinkSync(f.obligationPath);
    else readFailure = f.obligationPath;
    scratchErrorCode = "EACCES";
    reconcileTerminalCurStamps(root, "anvil", { warn: (message: string) => f.logs.push(message) }, [record]);
    expect(f.logs[0]).toContain(`ack-stamp-reconcile-failed: inbound actor=anvil path=${f.curPath} code=EACCES`);
    expect(f.logs[0]).not.toContain("obligation retained");
    if (presence === "unreadable") expect(f.logs[0]).toContain("state unknown");
  });
}

test("stamp reconciliation holds an obligation when an unreadable record cannot be attributed", () => {
  const f = terminalFixture("acked");
  realFs.unlinkSync(f.curPath);
  const unrelated = join(f.curDir, "timestamp-other.json");
  realFs.writeFileSync(unrelated, JSON.stringify({ id: "other" }));
  readFailure = unrelated;
  expect(f.reconcile().has("inbound")).toBe(true);
  expect(f.logs[0]).toContain(`path=${unrelated} code=EACCES`);
  expect(f.logs[0]).toContain("obligation retained");
});

for (const state of ["acked", "failed"] as const) {
  for (const lookup of ["missing", "ambiguous", "bounded"] as const) {
    test(`${state}: ${lookup} cur lookup holds the obligation`, () => {
      const f = terminalFixture(state);
      if (lookup === "missing") realFs.unlinkSync(f.curPath);
      if (lookup === "ambiguous") realFs.writeFileSync(join(f.curDir, "independent.json"), JSON.stringify({ id: "inbound" }));
      if (lookup === "bounded") {
        for (let i = 0; i < 4096; i++) realFs.writeFileSync(join(f.curDir, `${i}.json`), JSON.stringify({ id: `other-${i}` }));
      }
      expect(f.reconcile().has("inbound")).toBe(true);
      const code = lookup === "missing" ? "ENOENT" : lookup === "ambiguous" ? "AMBIGUOUS_ID" : "SCAN_LIMIT";
      expect(f.logs[0]).toContain(`path=${f.curDir} code=${code}`);
      expect(f.logs[0]).toContain("obligation retained");
      expect(realFs.existsSync(f.obligationPath)).toBe(true);
      if (lookup !== "missing") expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[state === "acked" ? "ackedAt" : "nackedAt"]).toBeUndefined();
    });
  }
}
