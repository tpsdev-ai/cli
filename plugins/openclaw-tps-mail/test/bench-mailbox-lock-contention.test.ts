import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createMailboxStore, measure, startChild } from "../scripts/bench-mailbox-lock-contention.mjs";

const script = resolve(import.meta.dir, "../scripts/bench-mailbox-lock-contention.mjs");
const runWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const result = spawnSync(process.execPath, [script, ...args], { env, timeout: 15000, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  return { ...result, exitCode: result.status };
};
const run = (...args: string[]) => runWithEnv(process.env, ...args);
const snapshot = (dir: string): unknown[] => readdirSync(dir).sort().map((name) => {
  const path = join(dir, name);
  const st = lstatSync(path);
  return [name, st.mode, st.isDirectory() ? snapshot(path) : readFileSync(path).toString("hex")];
});

test("benchmark runs real writers, sweep and watcher", async () => {
  const result = await measure(1, 1, 1, 1, 200, 10000);
  expect(result.writerWaits).toHaveLength(3);
  expect(result.writerAcquisitions).toBe(3);
  expect(result.sweepAcquisitions).toBe(1);
  expect(result.sweepHolds.length).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) expect(result.writerWaits[i]).toBeLessThanOrEqual(result.writerCalls[i]);
}, 15000);

test("holder JSON uses holder keys", () => {
  const result = run("--n=1", "--rounds=1", "--writes=1", "--sweeps=1", "--seed=200", "--holder=10", "--timeout=10", "--json");
  expect(result.exitCode).toBe(0);
  const line = result.stdout.toString().split("\n").find((line) => line.startsWith("JSON "))!;
  const data = JSON.parse(line.slice(5))["1"];
  expect(data.holderAcquisitions).toBe(1);
  expect(data.holderCollisions).toBeGreaterThanOrEqual(0);
  expect(data.sampledHolderOwnerSpanMs.n).toBeGreaterThan(0);
  expect(data.holderCallLatencyMs.n).toBe(1);
  expect(Object.keys(data).some((key) => /sweep/i.test(key))).toBe(false);
}, 20000);

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

test("benchmark rejects a completed child timeout after readiness", async () => {
  let injected = false;
  const launch = (role: string, opts: any, timeout: number) => {
    const job = startChild(role, opts, timeout);
    if (role !== "writer") return job;
    return { ...job, done: job.done.then((status: any) => {
      expect(existsSync(opts.flags.go)).toBe(true);
      expect(status.code).toBe(0);
      expect(status.timedOut).toBe(false);
      injected = true;
      return { ...status, timedOut: true };
    }) };
  };
  await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch))
    .rejects.toThrow('child failed: {"code":0,"stderr":"","timedOut":true}');
  expect(injected).toBe(true);
}, 15000);

test("direct roles refuse an existing mailbox with a forged marker", () => {
  const base = realpathSync(tmpdir());
  const dir = realpathSync(mkdtempSync(join(base, "bench-lock-")));
  const out = join(dir, "result.json");
  const token = "forged-token";
  try {
    mkdirSync(join(dir, "agent-a"));
    writeFileSync(join(dir, "agent-a", "message.json"), '{"body":"keep"}');
    writeFileSync(join(dir, ".bench-parent.json"), JSON.stringify({ pid: process.pid, token }));
    const before = snapshot(dir);
    for (const role of ["writer", "sweeper", "watch"]) {
      const result = runWithEnv({ ...process.env, TPS_BENCH_TOKEN: token, TPS_BENCH_ROOT: dir, TPS_BENCH_BASE: base },
        `--role=${role}`, `--dir=${dir}`, `--out=${out}`, `--ready=${join(dir, "ready")}`, `--go=${join(dir, "go")}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("refused mailbox directory");
      expect(snapshot(dir)).toEqual(before);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["existing", "symlink"]) {
  test(`mailbox creation refuses ${kind} store`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bench-lock-")));
    const store = join(root, "mailbox");
    try {
      mkdirSync(join(root, "existing"));
      writeFileSync(join(root, "existing", "message"), "keep");
      if (kind === "existing") mkdirSync(store);
      else symlinkSync(join(root, "existing"), store);
      expect(() => createMailboxStore(root, store)).toThrow();
      expect(readFileSync(join(root, "existing", "message"), "utf8")).toBe("keep");
      expect(existsSync(join(store, "agent-a"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("roles refuse a mailbox outside the benchmark root", async () => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "bench-existing-")));
  try {
    mkdirSync(join(external, "agent-a"));
    writeFileSync(join(external, "agent-a", "message"), "keep");
    const before = snapshot(external);
    const launch = (role: string, opts: any, timeout: number) => startChild(role,
      { ...opts, flags: { ...opts.flags, dir: external } }, timeout);
    await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch)).rejects.toThrow("barrier failed");
    expect(snapshot(external)).toEqual(before);
  } finally { rmSync(external, { recursive: true, force: true }); }
}, 15000);

test("roles refuse a writable benchmark root", async () => {
  const launch = (role: string, opts: any, timeout: number) => {
    chmodSync(opts.env.TPS_BENCH_ROOT, 0o770);
    return startChild(role, opts, timeout);
  };
  await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch)).rejects.toThrow("barrier failed");
}, 15000);

test("benchmark refuses a writable temporary base", () => {
  const base = mkdtempSync(join(tmpdir(), "bench-base-"));
  try {
    chmodSync(base, 0o777);
    const result = runWithEnv({ ...process.env, TMPDIR: base }, "--n=1", "--rounds=1", "--timeout=10");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unsafe temporary base");
    expect(readdirSync(base)).toEqual([]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("role refuses external output", async () => {
  const external = join(tmpdir(), `bench-external-${process.pid}.json`);
  const launch = (role: string, opts: any, timeout: number) => startChild(role,
    role === "writer" ? { ...opts, flags: { ...opts.flags, out: external } } : opts, timeout);
  await expect(measure(1, 1, 1, 1, 200, 10000, undefined, launch)).rejects.toThrow();
  expect(existsSync(external)).toBe(false);
}, 15000);
