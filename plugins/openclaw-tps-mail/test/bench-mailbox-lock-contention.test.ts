import { expect, test } from "bun:test";
import { acquireMailLockSync } from "../../../packages/agent/src/lib/mail-lock.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { benchmarkPaths, createMailboxStore, measure, startChild } from "../scripts/bench-mailbox-lock-contention.mjs";

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
  return [name, st.mode, st.isDirectory() ? snapshot(path) : st.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("hex")];
});

test("benchmark runs real writers, sweep and watcher", async () => {
  const launch = (role: string, opts: any, timeout: number) => {
    const job = startChild(role, opts, timeout);
    return { ...job, done: job.done.then((status: any) => {
      if (role === "writer" && status.code === 0) {
        const paths = benchmarkPaths(opts.env.TPS_BENCH_ROOT);
        expect(opts.flags.dir).toBe(paths.mailDir);
        expect(readdirSync(join(paths.store, ".obligations"))).toContain(`w-${job.pid}-0.json`);
        expect(existsSync(join(paths.mailDir, "mailbox"))).toBe(false);
      }
      return status;
    }) };
  };
  const result = await measure(1, 1, 1, 1, 200, 10000, undefined, launch);
  expect(result.writerWaits).toHaveLength(3);
  expect(result.writerAcquisitions).toBe(3);
  expect(result.sweepAcquisitions).toBe(1);
  expect(result.sweepHolds.length).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) expect(result.writerWaits[i]).toBeLessThanOrEqual(result.writerCalls[i]);
}, 15000);

for (const holder of [undefined, 10]) {
  test(`${holder === undefined ? "sweep" : "holder"} retries and counts a busy lock`, async () => {
    let release: (() => void) | undefined;
    const launch = (role: string, opts: any, timeout: number) => {
      if (role !== "sweeper") return startChild(role, opts, timeout);
      const ready = `${opts.flags.ready}.child`;
      const job = startChild(role, { ...opts, flags: { ...opts.flags, ready } }, timeout);
      const gate = (async () => {
        const deadline = Date.now() + timeout;
        while (!existsSync(ready)) {
          if (Date.now() >= deadline) throw new Error("sweeper readiness timeout");
          await new Promise((r) => setTimeout(r, 1));
        }
        const lock = acquireMailLockSync(benchmarkPaths(opts.env.TPS_BENCH_ROOT).store, { timeoutMs: 0 });
        expect(lock).not.toBeNull();
        release = () => lock!.release();
        writeFileSync(opts.flags.ready, "ready", { flag: "wx" });
        while (!existsSync(opts.flags.go)) {
          if (Date.now() >= deadline) throw new Error("sweeper barrier timeout");
          await new Promise((r) => setTimeout(r, 1));
        }
        await new Promise((r) => setTimeout(r, 100));
        release();
      })();
      return { ...job, done: Promise.all([job.done, gate]).then(([status]) => {
        expect(status.code).toBe(0);
        const data = JSON.parse(readFileSync(opts.flags.out, "utf8"));
        expect(data.errors).toBe(0);
        expect(data.failed).toBeGreaterThan(0);
        expect(data.collisions).toBe(data.failed);
        expect(data.waits).toHaveLength(data.acquisitions + data.failed);
        return status;
      }) };
    };
    try {
      const result = await measure(1, 1, 1, 1, 200, 10000, holder, launch);
      expect(result.sweepAcquisitions).toBe(1);
      expect(result.sweepContendedAttempts).toBeGreaterThan(0);
      expect(result.sweepCollisions).toBe(result.sweepContendedAttempts);
      expect(result.sweepWaits).toHaveLength(1 + result.sweepContendedAttempts);
      expect(result.sweepWaits.every((wait: number) => Number.isFinite(wait) && wait >= 0)).toBe(true);
    } finally { release?.(); }
  }, 15000);
}

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

for (const role of ["writer", "sweeper", "watch"]) {
  test(`direct ${role} refuses populated root/agent-a with a forged marker`, async () => {
    const base = realpathSync(tmpdir());
    const root = realpathSync(mkdtempSync(join(base, "bench-lock-")));
    const dir = root;
    const token = "forged-token";
    try {
      createMailboxStore(root);
      const od = join(root, "agent-a", ".obligations");
      mkdirSync(od, { mode: 0o700 });
      writeFileSync(join(od, "existing.json"), JSON.stringify({
        obligationId: "ob-existing", inboundId: "existing", inboundTimestamp: "2020-01-01T00:00:00.000Z",
        from: "sender-a", to: "agent-a", accountId: "default", state: "failed", deadlineAt: null,
        attempts: 1, lastTransitionAt: "2020-01-01T00:00:00.000Z",
      }), { mode: 0o600 });
      writeFileSync(join(root, ".bench-parent.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      const before = snapshot(root);
      const job = startChild(role, {
        env: { ...process.env, TPS_BENCH_TOKEN: token, TPS_BENCH_ROOT: root, TPS_BENCH_BASE: base },
        flags: { dir, out: join(root, "result.json"), ready: join(root, "ready"),
          go: join(root, "go"), ...(role === "watch" ? { stop: join(root, "stop") } : {}) },
      }, 1000);
      const result = await job.done;
      expect(snapshot(root)).toEqual(before);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("refused populated mailbox");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 5000);
}

for (const role of ["writer", "sweeper", "watch"]) {
  test(`direct ${role} refuses symlinked root/agent-a before readiness`, async () => {
    const base = realpathSync(tmpdir());
    const root = realpathSync(mkdtempSync(join(base, "bench-lock-")));
    const external = realpathSync(mkdtempSync(join(base, "bench-existing-")));
    const dir = root;
    const token = "forged-token";
    try {
      createMailboxStore(root);
      writeFileSync(join(external, "message"), "keep", { mode: 0o600 });
      rmSync(join(root, "agent-a"), { recursive: true });
      symlinkSync(external, join(root, "agent-a"));
      writeFileSync(join(root, ".bench-parent.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      const before = snapshot(root);
      const externalBefore = snapshot(external);
      const job = startChild(role, {
        env: { ...process.env, TPS_BENCH_TOKEN: token, TPS_BENCH_ROOT: root, TPS_BENCH_BASE: base },
        flags: { dir, out: join(root, "result.json"), ready: join(root, "ready"),
          go: join(root, "go"), ...(role === "watch" ? { stop: join(root, "stop") } : {}) },
      }, 1000);
      const result = await job.done;
      expect(snapshot(root)).toEqual(before);
      expect(snapshot(external)).toEqual(externalBefore);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid private directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }, 5000);
}

for (const role of ["writer", "sweeper", "watch"]) {
  for (const path of ["out", "ready", "go", ...(role === "watch" ? ["stop"] : [])]) {
    for (const kind of ["file", "dangling-symlink"]) {
      test(`direct ${role} refuses ${kind} at ${path} before readiness`, async () => {
        const base = realpathSync(tmpdir());
        const root = realpathSync(mkdtempSync(join(base, "bench-lock-")));
        const dir = root;
        const token = "forged-token";
        try {
          createMailboxStore(root);
          writeFileSync(join(root, ".bench-parent.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
          if (kind === "file") writeFileSync(join(root, path), "keep", { mode: 0o600 });
          else symlinkSync(join(root, "absent"), join(root, path));
          const before = snapshot(root);
          const job = startChild(role, {
            env: { ...process.env, TPS_BENCH_TOKEN: token, TPS_BENCH_ROOT: root, TPS_BENCH_BASE: base },
            flags: { dir, out: join(root, "out"), ready: join(root, "ready"),
              go: join(root, "go"), ...(role === "watch" ? { stop: join(root, "stop") } : {}) },
          }, 1000);
          const result = await job.done;
          expect(snapshot(root)).toEqual(before);
          expect(result.timedOut).toBe(false);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("refused path:");
        } finally { rmSync(root, { recursive: true, force: true }); }
      }, 5000);
    }
  }
}

for (const kind of ["existing", "symlink"]) {
  test(`mailbox creation refuses ${kind} store`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bench-lock-")));
    const store = benchmarkPaths(root).store;
    try {
      mkdirSync(join(root, "existing"));
      writeFileSync(join(root, "existing", "message"), "keep");
      if (kind === "existing") mkdirSync(store);
      else symlinkSync(join(root, "existing"), store);
      expect(() => createMailboxStore(root)).toThrow();
      expect(readFileSync(join(root, "existing", "message"), "utf8")).toBe("keep");
      expect(readdirSync(join(root, "existing"))).toEqual(["message"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("roles refuse an external mailDir argument", async () => {
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
