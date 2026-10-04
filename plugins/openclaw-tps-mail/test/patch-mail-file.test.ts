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
mock.module("node:fs", () => ({
  ...realFs,
  readdirSync: (...args: any[]) => {
    if (args[0] === listFailure) throw Object.assign(new Error("injected list failure"), { code: "EACCES" });
    return (realFs.readdirSync as any)(...args);
  },
  openSync: (...args: any[]) => {
    if (uncodedWriteFailure && String(args[0]).includes(".ack-")) throw new Error("injected write failure");
    return (realFs.openSync as any)(...args);
  },
  readFileSync: (...args: any[]) => {
    if (args[0] === readFailure && --readsUntilFailure <= 0) throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
    const result = (realFs.readFileSync as any)(...args);
    if (stampOnRead?.path === args[0] && --stampOnRead.count === 0) {
      const record = JSON.parse(String(result));
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

const { patchMailFile, reconcileTerminalCurStamps } = await import("../src/index.js");
const root = realFs.mkdtempSync(join(tmpdir(), "patch-mail-"));
const path = join(root, "record.json");

afterEach(() => {
  removeAfterRead = undefined;
  readsBeforeRemoval = readsUntilFailure = 1;
  readFailure = listFailure = undefined;
  stampOnRead = undefined;
  uncodedWriteFailure = false;
  realFs.rmSync(join(root, "anvil"), { recursive: true, force: true });
  realFs.rmSync(path, { force: true });
});

afterAll(() => realFs.rmSync(root, { recursive: true, force: true }));

describe("patchMailFile", () => {
  test("patches an existing record", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    expect(patchMailFile(path, { read: true })).toEqual({ ok: true });
    expect(JSON.parse(realFs.readFileSync(path, "utf-8"))).toEqual({ id: "inbound", body: "hello", read: true });
  });

  test("reports a missing record without creating it", () => {
    expect(patchMailFile(path, { read: true })).toMatchObject({ ok: false, reason: "record-missing" });
    expect(realFs.existsSync(path)).toBe(false);
  });

  test("reports a record removed after the read without recreating it", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    removeAfterRead = path;
    expect(patchMailFile(path, { ackedAt: "receipt", read: true })).toMatchObject({ ok: false, reason: "record-missing" });
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
  realFs.writeFileSync(obligationPath, JSON.stringify({ inboundId: "inbound", state, failure: "empty" }));
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
      expect(f.logs[0]).toContain(`${kind}-stamp-reconcile-failed: inbound actor=anvil state=${state} path=${f.curPath} code=ENOENT`);
      expect(f.logs[0]).toContain("inspect the missing cur record; obligation retained");
      expect(realFs.existsSync(f.curPath)).toBe(false);
      expect(JSON.parse(realFs.readFileSync(f.obligationPath, "utf8")).state).toBe(state);
    });

    test(`${kind}: an uncoded write failure is reported and the next run can stamp`, () => {
      const f = terminalFixture(state);
      uncodedWriteFailure = true;
      f.reconcile();
      expect(f.logs[0]).toContain(`actor=anvil state=${state} path=${f.curPath} code=WRITE_FAILED`);
      expect(f.logs[0]).toContain("restore writable records and restart the account; obligation retained");
      uncodedWriteFailure = false;
      f.reconcile();
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[key]).toBeDefined();
    });

    test(`${kind}: running reconcile twice leaves bytes and file metadata unchanged`, () => {
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

  for (const stage of ["obligation-list", "obligation-read", "cur-list", "cur-read", "cur-reread"] as const) {
    test(`${stage}: a read failure is diagnosed and remains recoverable`, () => {
      const f = terminalFixture("acked");
      const target = stage === "obligation-list" ? f.obligationDir
        : stage === "obligation-read" ? f.obligationPath
        : stage === "cur-list" ? f.curDir : f.curPath;
      if (stage.endsWith("list")) listFailure = target;
      else {
        readFailure = target;
        if (stage === "cur-reread") readsUntilFailure = 2;
      }
      f.reconcile();
      expect(f.logs[0]).toContain("stamp-reconcile-read-failed");
      expect(f.logs[0]).toContain("actor=anvil state=");
      expect(f.logs[0]).toContain(`path=${target} code=EACCES`);
      expect(f.logs[0]).toContain("restore readable records and restart the account");
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

  test("a terminal obligation without a cur record is reported", () => {
    const f = terminalFixture("acked");
    realFs.unlinkSync(f.curPath);
    f.reconcile();
    expect(f.logs[0]).toContain("code=ENOENT");
    expect(f.logs[0]).toContain("obligation retained");
    expect(realFs.existsSync(f.obligationPath)).toBe(true);
  });
});
