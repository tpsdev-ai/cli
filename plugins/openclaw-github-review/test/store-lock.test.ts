/**
 * store-lock.test.ts — the one exclusive lock per store file: it is created
 * exclusively and removed after the operation (also when the operation
 * throws); a lock held past the timeout — a stale lock — fails CLOSED with the
 * lock path, its recorded holder and the remedy, and is never removed by a
 * process that did not create it. (Two real processes contending for it are
 * in audit-outcomes.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreLockBusyError, withStoreLock } from "../src/store-lock.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("store-lock", () => {
  test("the lock exists, naming its holder, only while the operation runs", () => {
    const store = join(root, "s.json");
    const seen = withStoreLock(store, "test op", () => JSON.parse(readFileSync(`${store}.lock`, "utf8")) as Record<string, unknown>);
    expect(seen).toMatchObject({ pid: process.pid, op: "test op", token: expect.any(String) });
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  test("an operation that throws still releases the lock", () => {
    const store = join(root, "s.json");
    expect(() =>
      withStoreLock(store, "boom", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  test("the lock is exclusive: a nested acquisition of the same store fails closed instead of entering", () => {
    const store = join(root, "s.json");
    let inner = false;
    expect(() =>
      withStoreLock(store, "outer", () =>
        withStoreLock(
          store,
          "inner",
          () => {
            inner = true;
          },
          50,
        ),
      ),
    ).toThrow(StoreLockBusyError);
    expect(inner).toBe(false);
  });

  test("a STALE lock fails closed after the timeout, naming the path, the holder and the remedy — and is left in place", () => {
    const store = join(root, "s.json");
    const lock = `${store}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 4242, host: "gw", since: "2026-01-01T00:00:00Z", op: "reserve", token: "theirs" }));
    let err: StoreLockBusyError | null = null;
    const start = Date.now();
    try {
      withStoreLock(store, "mine", () => {}, 100);
    } catch (e) {
      err = e as StoreLockBusyError;
    }
    expect(err).toBeInstanceOf(StoreLockBusyError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    expect(err!.message).toContain(lock);
    expect(err!.message).toContain("pid 4242 on gw since 2026-01-01T00:00:00Z for reserve");
    expect(err!.remedy()).toContain(`remove ${lock}`);
    expect(err!.pathFree("reconcileFile")).not.toContain(root);
    expect(err!.pathFree("reconcileFile")).toContain('reconcileFile + ".lock"');
    expect(readFileSync(lock, "utf8")).toContain("theirs");
  });

  test("a process never removes a lock that is not its own", () => {
    const store = join(root, "s.json");
    const lock = `${store}.lock`;
    withStoreLock(store, "mine", () => {
      // The host (wrongly) removed our lock and another process took it.
      rmSync(lock);
      writeFileSync(lock, JSON.stringify({ pid: 1, host: "other", since: "t", op: "x", token: "theirs" }));
    });
    expect(readFileSync(lock, "utf8")).toContain("theirs");
  });
});
