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

function plantContendedLock(): void {
  const dir = mailLockPath(root);
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, startToken: processStartToken(process.pid) }));
}

test("a contended synchronous acquisition returns null on timeout", () => {
  plantContendedLock();
  expect(acquireMailLockSync(root, { timeoutMs: 60 })).toBeNull();
});

for (const [name, opts, expectedMs] of [
  ["a contended synchronous acquisition uses the default retry interval of 2 ms", {}, 2],
  ["pollMs overrides the default retry interval", { pollMs: 7 }, 7],
] as const) {
  test(name, () => {
    plantContendedLock();
    const waits: number[] = [];
    const realWait = Atomics.wait;
    const spy = spyOn(Atomics, "wait").mockImplementation(((array: Int32Array, index: number, value: number, timeout?: number) => {
      expect(value).toBe(array[index]);
      const result = realWait(array, index, value, timeout);
      expect(result).toBe("timed-out");
      waits.push(timeout ?? 0);
      return result;
    }) as typeof Atomics.wait);
    try {
      expect(acquireMailLockSync(root, { timeoutMs: 100, ...opts })).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms === expectedMs)).toBe(true);
  });
}
