import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { measure, startChild } from "../scripts/bench-mailbox-lock-contention.mjs";

const script = resolve(import.meta.dir, "../scripts/bench-mailbox-lock-contention.mjs");
const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { env: process.env });

test("benchmark runs real writers, sweep and watcher", async () => {
  const result = await measure(1, 1, 1, 1, 200, 10000);
  expect(result.writerWaits).toHaveLength(3);
  expect(result.writerAcquisitions).toBe(3);
  expect(result.sweepAcquisitions).toBe(1);
  expect(result.sweepHolds.length).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) expect(result.writerWaits[i]).toBeLessThanOrEqual(result.writerCalls[i]);
}, 15000);

test("holder reports successful acquisitions", async () => {
  const result = await measure(1, 1, 1, 1, 200, 10000, "10");
  expect(result.sweepAcquisitions).toBe(1);
}, 15000);

for (const fault of ["exit", "missing-output", "writer-error", "missing-samples", "failed-acquisition", "removals", "missing-watcher", "empty-watcher"]) {
  test(`benchmark rejects ${fault}`, async () => {
    const launch = (role: string, opts: any, timeout: number) => {
      const job = startChild(role, opts, timeout);
      const victim = fault.includes("watcher") ? "watch" : fault === "removals" ? "sweeper" : "writer";
      if (role !== victim) return job;
      const done = job.done.then((status: any) => {
        if (fault === "exit") return { ...status, code: 7 };
        if (fault === "missing-output" || fault === "missing-watcher") rmSync(opts.flags.out, { force: true });
        else {
          const data = JSON.parse(readFileSync(opts.flags.out, "utf8"));
          if (fault === "writer-error") data.errors = 1;
          if (fault === "missing-samples") data.calls.pop();
          if (fault === "failed-acquisition") data.failed = 1;
          if (fault === "removals") data.removals[0] = 0;
          writeFileSync(opts.flags.out, JSON.stringify(fault === "empty-watcher" ? [] : data));
        }
        return status;
      });
      return { ...job, done };
    };
    await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch)).rejects.toThrow();
  }, 15000);
}

test("timed-out benchmark exits without percentiles", () => {
  const result = run("--n=1", "--rounds=1", "--timeout=0.001");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).not.toContain("p50");
});

test("direct roles refuse an unmarked directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-refusal-"));
  const out = join(dir, "result.json");
  try {
    for (const role of ["writer", "sweeper", "watch"]) {
      const result = run(`--role=${role}`, `--dir=${dir}`, `--out=${out}`);
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(out)).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parent-created role refuses external output", async () => {
  const external = join(tmpdir(), `bench-external-${process.pid}.json`);
  const launch = (role: string, opts: any, timeout: number) => startChild(role,
    role === "writer" ? { ...opts, flags: { ...opts.flags, out: external } } : opts, timeout);
  await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch)).rejects.toThrow();
  expect(existsSync(external)).toBe(false);
}, 15000);
