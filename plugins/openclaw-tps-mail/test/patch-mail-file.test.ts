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
let deleteFailure: string | undefined;
let renameFailure: string | undefined;
let replaceIdentity = false;
mock.module("node:fs", () => ({
  ...realFs,
  readdirSync: (...args: any[]) => {
    if (args[0] === listFailure) throw Object.assign(new Error("injected list failure"), { code: "EACCES" });
    return (realFs.readdirSync as any)(...args);
  },
  unlinkSync: (...args: any[]) => {
    if (args[0] === deleteFailure) throw Object.assign(new Error("injected delete failure"), { code: "EACCES" });
    return (realFs.unlinkSync as any)(...args);
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
const { createObligation, listObligations, sweepTerminalObligations } = await import("../src/obligations.js");
const root = realFs.mkdtempSync(join(tmpdir(), "patch-mail-"));
const path = join(root, "record.json");

afterEach(() => {
  removeAfterRead = undefined;
  readsBeforeRemoval = readsUntilFailure = 1;
  readFailure = listFailure = undefined;
  stampOnRead = undefined;
  uncodedWriteFailure = replaceIdentity = false;
  scratchErrorCode = undefined;
  deleteFailure = renameFailure = undefined;
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
    test(`a scratch ${code} failure names the scratch path and preserves the record`, () => {
      const f = terminalFixture("acked");
      scratchErrorCode = code;
      const result = patchMailFile(f.curPath, { ackedAt: "done" }, "ackedAt", "inbound");
      expect(result).toMatchObject({ ok: false, reason: "write-failed", code });
      if (result.ok) throw new Error("expected scratch failure");
      expect(result.path).toStartWith(join(f.curDir, ".ack-"));
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
      expect(f.logs[0]).toContain(`${kind}-stamp-reconcile-failed: inbound actor=anvil state=${state} path=${f.curPath} code=ENOENT`);
      expect(f.logs[0]).toContain("obligation retained; fix the path named above and restart the account");
      expect(realFs.existsSync(f.curPath)).toBe(false);
      expect(JSON.parse(realFs.readFileSync(f.obligationPath, "utf8")).state).toBe(state);
    });

    test(`${kind}: a missing cur record is reported at its expected file path`, () => {
      const f = terminalFixture(state);
      realFs.unlinkSync(f.curPath);
      f.reconcile();
      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]).toContain(`state=${state} path=${join(f.curDir, "inbound.json")} code=ENOENT`);
    });

    test(`${kind}: an uncoded write failure is reported and the next run can stamp`, () => {
      const f = terminalFixture(state);
      uncodedWriteFailure = true;
      f.reconcile();
      expect(f.logs[0]).toContain(`actor=anvil state=${state} path=${f.curPath} code=WRITE_FAILED`);
      expect(f.logs[0]).toContain("obligation retained; fix the path named above and restart the account");
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
      expect(f.logs[0]).toContain("fix the path named above and restart the account");
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

for (const invalid of [null, 7, "bad", [], { inboundId: "bad" }]) {
  test(`invalid obligation ${JSON.stringify(invalid)} is reported and a later terminal record is reconciled`, () => {
    const f = terminalFixture("acked");
    const badPath = join(f.obligationDir, "000-bad.json");
    realFs.writeFileSync(badPath, JSON.stringify(invalid));
    const errors: string[] = [];
    expect(listObligations(root, "anvil", (path, code) => errors.push(`${path}:${code}`))).toHaveLength(1);
    expect(errors).toEqual([`${badPath}:INVALID_RECORD`]);
    expect(() => f.reconcile()).not.toThrow();
    expect(f.logs[0]).toContain(`actor=anvil state=unknown path=${badPath} code=INVALID_RECORD`);
    expect(f.logs[0]).toContain("fix the path named above and restart the account");
    expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8")).ackedAt).toBeDefined();
    expect(realFs.readFileSync(badPath, "utf8")).toBe(JSON.stringify(invalid));
  });
}

test("a null cur record is reported as unreadable", () => {
  const f = terminalFixture("acked");
  realFs.writeFileSync(f.curPath, "null");
  f.reconcile();
  expect(f.logs[0]).toContain(`actor=anvil state=acked path=${f.curPath} code=INVALID_RECORD`);
  expect(f.logs[0]).toContain("fix the path named above and restart the account");
});

test("creation refuses an unreadable existing terminal obligation", () => {
  const f = terminalFixture("acked");
  const bytes = realFs.readFileSync(f.obligationPath, "utf8");
  readFailure = f.obligationPath;
  expect(() => createObligation(root, "anvil", () => ({ inboundId: "inbound", state: "pending" }) as any)).toThrow("state=unknown");
  expect(realFs.readFileSync(f.obligationPath, "utf8")).toBe(bytes);
});

for (const state of ["acked", "failed"] as const) {
  for (const stage of ["cur-list", "cur-lookup-read", "cur-reread", "locked-read", "stamp-write", "stamp-rename", "cur-missing", "identity-change"] as const) {
    test(`${state}: ${stage} holds an aged timestamped inbound and continues healthy records`, () => {
      const f = terminalFixture(state);
      if (stage === "cur-list") listFailure = f.curDir;
      if (stage.endsWith("read")) {
        readFailure = f.curPath;
        readsUntilFailure = stage === "cur-reread" ? 2 : stage === "locked-read" ? 3 : 1;
      }
      if (stage === "stamp-write") uncodedWriteFailure = true;
      if (stage === "stamp-rename") renameFailure = f.curPath;
      if (stage === "cur-missing") realFs.unlinkSync(f.curPath);
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
      sweepTerminalObligations(root, "anvil", 7, { warn: (m) => f.logs.push(m) }, Date.now(), 28, unresolved, undefined, [{ inboundId: "inbound", obligationId: "ob-inbound" } as any]);
      expect(realFs.readFileSync(f.obligationPath, "utf8")).toBe(bytes);
      expect(realFs.existsSync(receiptPath)).toBe(true);
      expect(realFs.existsSync(join(f.obligationDir, "healthy.json"))).toBe(false);
      expect(f.logs.filter((m) => m.includes("actor=anvil"))).toHaveLength(1);
      expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain(`state=${state}`);
      expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain("restart the account");
      replaceIdentity = false;
      if (stage === "cur-missing" || stage === "identity-change") realFs.writeFileSync(f.curPath, JSON.stringify({ id: "inbound" }));
      expect(f.reconcile().size).toBe(0);
      expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8"))[state === "acked" ? "ackedAt" : "nackedAt"]).toBeDefined();
    });
  }
}

for (const stage of ["obligation-reread", "cur-retention-read", "cur-retention-list", "obligation-delete", "abandonment-write", "age", "identity", "cur-retention-missing"] as const) {
  test(`retention ${stage} retains evidence and reports once`, () => {
    const f = terminalFixture(stage === "abandonment-write" ? "failed" : "acked");
    const record = JSON.parse(realFs.readFileSync(f.obligationPath, "utf8"));
    if (stage === "abandonment-write") record.nackPending = true;
    if (stage === "age") record.lastTransitionAt = "invalid";
    if (stage === "identity") record.inboundId = "other";
    realFs.writeFileSync(f.obligationPath, JSON.stringify(record));
    realFs.writeFileSync(f.curPath, JSON.stringify({ id: "inbound", ackedAt: "done" }));
    const bytes = realFs.readFileSync(f.obligationPath, "utf8");
    if (stage === "obligation-reread") readFailure = f.obligationPath;
    if (stage === "cur-retention-read") readFailure = f.curPath;
    if (stage === "cur-retention-list") listFailure = f.curDir;
    if (stage === "cur-retention-missing") realFs.unlinkSync(f.curPath);
    if (stage === "obligation-delete") deleteFailure = f.obligationPath;
    if (stage === "abandonment-write") renameFailure = f.obligationPath;
    const unresolved = new Set<string>();
    sweepTerminalObligations(root, "anvil", 7, { warn: (m) => f.logs.push(m) }, Date.now(), 28, unresolved, (path, code, id, state) => {
      f.logs.push(`actor=anvil state=${state} path=${path} code=${code}; fix the path named above and restart the account`);
      unresolved.add(id);
    });
    expect(unresolved.has("inbound")).toBe(true);
    expect(realFs.readFileSync(f.obligationPath, "utf8")).toBe(bytes);
    expect(f.logs.filter((m) => m.includes("actor=anvil"))).toHaveLength(1);
    expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain("restart the account");
  });
}

test("retention holds a timestamped cur record before abandoning its nack debt", () => {
  const f = terminalFixture("failed");
  const record = JSON.parse(realFs.readFileSync(f.obligationPath, "utf8"));
  record.nackPending = true;
  realFs.writeFileSync(f.obligationPath, JSON.stringify(record));
  const bytes = realFs.readFileSync(f.obligationPath, "utf8");
  const result = sweepTerminalObligations(root, "anvil", 7);
  expect(result.heldForRecovery).toBe(1);
  expect(result.abandonedForNack).toBe(0);
  expect(realFs.readFileSync(f.obligationPath, "utf8")).toBe(bytes);
});

for (const stage of ["receipt-list", "receipt-read", "receipt-delete", "receipt-age"] as const) {
  test(`startup retention ${stage} reports an unresolved record and retains evidence`, () => {
    const f = terminalFixture("acked");
    realFs.writeFileSync(f.curPath, JSON.stringify({ id: "inbound", ackedAt: "done" }));
    const record = JSON.parse(realFs.readFileSync(f.obligationPath, "utf8"));
    const receiptDir = join(f.obligationDir, "receipts");
    realFs.mkdirSync(receiptDir);
    const receiptPath = join(receiptDir, "ob-inbound.json");
    realFs.writeFileSync(receiptPath, JSON.stringify({ obligationId: "ob-inbound", ts: new Date(0).toISOString() }));
    if (stage === "receipt-list") listFailure = receiptDir;
    if (stage === "receipt-read") readFailure = receiptPath;
    if (stage === "receipt-age") {
      realFs.unlinkSync(f.obligationPath);
      realFs.writeFileSync(receiptPath, JSON.stringify({ obligationId: "ob-inbound", ts: "invalid" }));
    }
    if (stage === "receipt-delete") {
      realFs.unlinkSync(f.obligationPath);
      deleteFailure = receiptPath;
    }
    const unresolved = new Set<string>();
    const onFailure = (path: string, code: string, id: string, state: string) => {
      f.logs.push(`actor=anvil state=${state} path=${path} code=${code}; fix the path named above and restart the account`);
      unresolved.add(id);
    };
    sweepTerminalObligations(root, "anvil", 7, { warn: (m) => f.logs.push(m) }, Date.now(), 28, unresolved, onFailure, [record]);
    expect(unresolved.size).toBe(1);
    expect(realFs.existsSync(receiptPath)).toBe(true);
    if (stage !== "receipt-delete" && stage !== "receipt-age") expect(realFs.existsSync(f.obligationPath)).toBe(true);
    expect(f.logs.filter((m) => m.includes("actor=anvil"))).toHaveLength(1);
    expect(f.logs.find((m) => m.includes("actor=anvil"))).toContain(`path=${stage === "receipt-list" ? receiptDir : receiptPath} code=${stage === "receipt-age" ? "INVALID_TIMESTAMP" : "EACCES"}`);
  });
}

test("obligation filename and inboundId must agree before startup uses the record", () => {
  const f = terminalFixture("acked");
  const record = JSON.parse(realFs.readFileSync(f.obligationPath, "utf8"));
  record.inboundId = "other";
  realFs.writeFileSync(f.obligationPath, JSON.stringify(record));
  expect([...f.reconcile()].sort()).toEqual(["inbound", "other"]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain("INVALID_RECORD");
  expect(JSON.parse(realFs.readFileSync(f.curPath, "utf8")).ackedAt).toBeUndefined();
});

for (const failure of ["directory", "file"] as const) {
  test(`retention distinguishes a ${failure} read failure from the literal star file`, () => {
    const dir = join(root, "anvil", ".obligations");
    realFs.mkdirSync(dir, { recursive: true });
    const path = failure === "directory" ? dir : join(dir, "*.json");
    if (failure === "directory") listFailure = path;
    else {
      realFs.writeFileSync(path, "{}");
      readFailure = path;
    }
    const logs: string[] = [];
    sweepTerminalObligations(root, "anvil", 7, { warn: (m) => logs.push(m) });
    const diagnostic = logs.find((m) => m.includes("retention-unresolved"))!;
    expect(diagnostic).toContain(`path=${path} code=EACCES`);
    expect(diagnostic).toContain("fix the path named above and restart the account");
    if (failure === "directory") {
      expect(diagnostic).toContain("retention-unresolved: actor=anvil state=unknown");
      expect(diagnostic).not.toContain("obligation retained");
    } else {
      expect(diagnostic).toContain("retention-unresolved: * actor=anvil state=unknown");
      expect(diagnostic).toContain("obligation retained");
    }
  });
}
