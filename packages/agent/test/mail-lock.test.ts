import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMailLockSync, mailLockPath, processStartToken } from "../src/lib/mail-lock.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-lock-wait-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Plant a lock owned by a live process (this one), with a start token that
 * matches, so it is provably "alive" and cannot be reclaimed. An acquisition
 * therefore has no route to the lock and must wait the timeout out.
 */
function plantLiveLock(): void {
  const dir = mailLockPath(root);
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, startToken: processStartToken(process.pid) }));
}

test("a contended synchronous acquisition honours timeoutMs within a small margin", () => {
  plantLiveLock();
  const timeoutMs = 60;
  const started = performance.now();
  const lock = acquireMailLockSync(root, { timeoutMs });
  const elapsed = performance.now() - started;
  expect(lock).toBeNull();
  // It must not give up early, and must not run far past the timeout.
  expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
  expect(elapsed).toBeLessThan(timeoutMs + 60);
});

test("a contended synchronous acquisition retries on a short positive interval", () => {
  plantLiveLock();
  const waits: number[] = [];
  const spy = spyOn(Atomics, "wait").mockImplementation(((array: Int32Array, index: number, value: number, timeout?: number) => {
    waits.push(timeout ?? 0);
    return "timed-out";
  }) as typeof Atomics.wait);
  try {
    expect(acquireMailLockSync(root, { timeoutMs: 20 })).toBeNull();
  } finally {
    spy.mockRestore();
  }
  // Each attempt blocks on Atomics.wait for a positive interval, and that
  // interval is shorter than the old 25 ms poll.
  expect(waits.length).toBeGreaterThan(0);
  expect(waits.every((ms) => ms > 0)).toBe(true);
  expect(Math.max(...waits)).toBeLessThan(25);
});
