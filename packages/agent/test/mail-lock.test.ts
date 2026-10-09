import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const HOLDER_MODULE = fileURLToPath(new URL("../src/lib/mail-lock.ts", import.meta.url));

/** Spawn a real second process that acquires `root`'s lock and holds it. */
function spawnLockHolder(): { child: ChildProcess; ready: Promise<void>; exited: Promise<number | null> } {
  const child = spawn("bun", ["--eval", `
    import { acquireMailLock } from ${JSON.stringify(HOLDER_MODULE)};
    const lock = await acquireMailLock(${JSON.stringify(root)});
    if (!lock) { process.stdout.write("unavailable"); process.exit(2); }
    process.stdout.write("ready");
    process.stdin.resume();
    process.stdin.once("end", () => { lock.release(); process.exit(0); });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock holder did not become ready in time")), 10000);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`lock holder exited before readiness (code ${code})`)); });
    child.stdout?.once("data", (chunk) => {
      clearTimeout(timer);
      const line = chunk.toString();
      if (line === "ready") resolve();
      else reject(new Error(`lock holder signalled ${JSON.stringify(line)}`));
    });
  });
  return { child, ready, exited };
}

test("a contended synchronous acquisition returns null after waiting about timeoutMs", async () => {
  const timeoutMs = 400;
  // The holder is a real second process, so the wait below is genuine
  // inter-process contention. The lower bound rejects an acquirer whose measured
  // wait is below 0.9 * timeoutMs, targeting the one-retry and small-cap regressions.
  const { child, ready, exited } = spawnLockHolder();
  try {
    await ready;
    const started = performance.now();
    expect(acquireMailLockSync(root, { timeoutMs })).toBeNull();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(0.9 * timeoutMs);
    expect(elapsed).toBeLessThan(timeoutMs + 3000);
  } finally {
    child.stdin?.end("release");
    child.kill("SIGKILL");
    await exited;
  }
}, 15000);

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
