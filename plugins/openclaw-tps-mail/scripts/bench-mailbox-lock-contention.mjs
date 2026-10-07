#!/usr/bin/env bun
/**
 * Run: bun plugins/openclaw-tps-mail/scripts/bench-mailbox-lock-contention.mjs
 * Flags: --n=1,4,16 --writes=10 --sweeps=8 --seed=200 --rounds= --target=1500
 *        --timeout=120 --holder=<ms> --json
 * Acquisition time includes only acquireMailLock[Sync]. Whole-write latency
 * includes each separate create, transition or write call. Sweep hold estimates
 * are sampled owner-file spans; sampling may miss acquisitions or split spans.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = dirname(SCRIPT);
const ENTRY = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT);
const F = Object.fromEntries((ENTRY ? process.argv.slice(2) : []).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) throw new Error(`invalid argument: ${a}`);
  return [m[1], m[2] ?? "true"];
}));
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const metrics = { waits: [], acquisitions: 0, collisions: 0, failed: 0, errors: 0 };
const AGENT = "agent-a";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const QUIET = { info() {}, warn() {} };
let obligationsDir, receiptsDir, sweepTerminalObligations, writeObligation, createObligation, transitionObligation, acquireMailLockSync;

function positive(name, fallback) {
  const v = Number(F[name] ?? fallback);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`invalid --${name}`);
  return v;
}

function confinedPath(root, path) {
  const p = resolve(path);
  if (dirname(p) !== root || realpathSync(dirname(p)) !== root || existsSync(p)) {
    throw new Error(`refused path: ${path}`);
  }
  return p;
}

function verifyRole() {
  if (!["writer", "sweeper", "watch"].includes(F.role)) throw new Error("unknown role");
  const root = realpathSync(F.dir);
  if (resolve(F.dir) !== root) throw new Error("noncanonical role directory");
  const marker = join(root, ".bench-parent.json");
  if (!lstatSync(marker).isFile()) throw new Error("invalid parent marker");
  const m = JSON.parse(readFileSync(marker, "utf8"));
  if (m.token !== process.env.TPS_BENCH_TOKEN || !m.token || m.pid !== process.ppid) {
    throw new Error("role requires its creating parent");
  }
  for (const name of ["out", "ready"]) F[name] = confinedPath(root, F[name]);
  for (const name of ["go", ...(F.role === "watch" ? ["stop"] : [])]) {
    if (resolve(F[name]) !== join(root, name)) throw new Error(`invalid ${name} path`);
  }
  const mailbox = join(root, AGENT);
  if (!lstatSync(mailbox).isDirectory() || realpathSync(mailbox) !== mailbox) throw new Error("invalid mailbox");
  return root;
}

async function loadMeasuredComponents() {
  globalThis.__mailBench = (kind, value, lock) => {
    if (kind === "collision") metrics.collisions++;
    else {
      metrics.waits.push(value);
      if (lock) metrics.acquisitions++;
      else metrics.failed++;
    }
  };
  Bun.plugin({
    name: "mail-acquisition-timer",
    setup(build) {
      build.onLoad({ filter: /[/\\]lib[/\\]mail-lock\.js$/ }, ({ path }) => {
        let source = readFileSync(path, "utf8");
        const start = "const attempt = mailLockAttempts(root, opts);";
        const finish = /if \(step\.done\)\s*return step\.value;/g;
        const collision = "if (Date.now() >= deadline)";
        if (source.split(start).length !== 3 || [...source.matchAll(finish)].length !== 2 || !source.includes(collision)) {
          throw new Error("mail-lock instrumentation contract changed");
        }
        source = source.replaceAll(start, `const benchStart = performance.now(); ${start}`)
          .replace(finish, "if (step.done) { globalThis.__mailBench('acquired', performance.now() - benchStart, step.value); return step.value; }")
          .replace(collision, `globalThis.__mailBench('collision'); ${collision}`);
        return { contents: source, loader: "js" };
      });
    },
  });
  ({ obligationsDir, receiptsDir, sweepTerminalObligations, writeObligation, createObligation, transitionObligation } =
    await import(resolve(HERE, "../src/obligations.js")));
  ({ acquireMailLockSync } = await import("@tpsdev-ai/agent"));
}

function atomicWrite(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { flag: "wx" });
  renameSync(tmp, path);
}

function makeRecord(obligationId, inboundId, state, iso) {
  return { obligationId, inboundId, inboundTimestamp: iso, from: "sender-a", to: AGENT,
    accountId: "default", state, deadlineAt: null, attempts: state === "pending" ? 0 : 1, lastTransitionAt: iso };
}

function seedAgedBatch(mailDir, n, tag) {
  const od = obligationsDir(mailDir, AGENT);
  const rd = receiptsDir(mailDir, AGENT);
  mkdirSync(od, { recursive: true });
  mkdirSync(rd, { recursive: true });
  const old = new Date(Date.now() - 200 * DAY_MS).toISOString();
  for (let i = 0; i < n; i++) {
    const inboundId = `seed-${tag}-${i}`;
    const obligationId = `ob-${inboundId}`;
    atomicWrite(join(od, `${inboundId}.json`), JSON.stringify(makeRecord(obligationId, inboundId, "failed", old)));
    atomicWrite(join(rd, `${obligationId}.json`), JSON.stringify({ replyId: `reply-${obligationId}`,
      obligationId, replyToId: `thread-${inboundId}`, route: "local", ts: old, signedReply: "{}" }));
  }
}

async function roleMain() {
  const root = verifyRole();
  if (F.role !== "watch") await loadMeasuredComponents();
  writeFileSync(F.ready, "ready", { flag: "wx" });
  while (!existsSync(F.go)) await pause(1);
  if (F.role === "watch") {
    const ownerPath = join(root, AGENT, ".mail-lock", "owner.json");
    const spans = [];
    let current = null;
    let start = 0;
    while (!existsSync(F.stop)) {
      let owner = null;
      try {
        const o = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (Number.isInteger(o.pid) && typeof o.nonce === "string") owner = o;
      } catch {}
      if (owner?.nonce !== current?.nonce) {
        if (current) spans.push({ pid: current.pid, ms: nowMs() - start });
        current = owner;
        start = nowMs();
      }
    }
    if (current) spans.push({ pid: current.pid, ms: nowMs() - start });
    writeFileSync(F.out, JSON.stringify(spans), { flag: "wx" });
    return;
  }
  const calls = [];
  const removals = [];
  if (F.role === "writer") {
    for (let j = 0; j < positive("writes", 10); j++) {
      const inboundId = `w-${process.pid}-${j}`;
      const obligationId = `ob-${inboundId}`;
      const iso = new Date().toISOString();
      for (const call of [
        () => createObligation(root, AGENT, () => makeRecord(obligationId, inboundId, "pending", iso), QUIET),
        () => transitionObligation(root, AGENT, inboundId, "delivering", {}, QUIET),
        () => writeObligation(root, AGENT, makeRecord(obligationId, inboundId, "posted", iso)),
      ]) {
        const start = nowMs();
        call();
        calls.push(nowMs() - start);
      }
    }
  } else {
    const seed = positive("seed", 200);
    const holder = F.holder === undefined ? null : Number(F.holder);
    if (holder !== null && (!Number.isFinite(holder) || holder < 0)) throw new Error("invalid holder");
    for (let j = 0; j < positive("sweeps", 8); j++) {
      seedAgedBatch(root, seed, j);
      const start = nowMs();
      if (holder !== null) {
        const lock = acquireMailLockSync(join(root, AGENT), { timeoutMs: 0 });
        if (!lock) throw new Error("holder acquisition failed");
        try {
          if (holder > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holder);
        } finally { lock.release(); }
      } else {
        const res = sweepTerminalObligations(root, AGENT, RETENTION_DAYS, QUIET);
        removals.push(res.removed);
        if (res.removed !== seed || res.receiptsRemoved !== seed || res.unreadable || res.receiptsUnreadable) {
          throw new Error(`incomplete sweep: ${JSON.stringify(res)}`);
        }
      }
      calls.push(nowMs() - start);
    }
  }
  writeFileSync(F.out, JSON.stringify({ ...metrics, calls, removals }), { flag: "wx" });
}

export function startChild(role, opts, timeoutMs) {
  const args = [SCRIPT, `--role=${role}`];
  for (const [key, value] of Object.entries(opts.flags)) args.push(`--${key}=${value}`);
  const child = spawn(process.execPath, args, { env: opts.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let timedOut = false;
  const done = new Promise((res) => {
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.on("data", (d) => { stderr += d; });
    child.once("error", (err) => { clearTimeout(timer); res({ code: null, stderr: String(err), timedOut }); });
    child.once("close", (code) => { clearTimeout(timer); res({ code, stderr, timedOut }); });
  });
  return { child, pid: child.pid, done };
}

function samples(values, count, label) {
  if (!Array.isArray(values) || values.length !== count || values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error(`invalid ${label} samples`);
  }
}

export async function measure(n, rounds, writes, sweeps, seed, timeoutMs, holder, launch = startChild) {
  const result = { writerWaits: [], writerCalls: [], sweepCalls: [], sweepHolds: [],
    writerAcquisitions: 0, writerCollisions: 0, sweepAcquisitions: 0, sweepCollisions: 0 };
  for (let round = 0; round < rounds; round++) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bench-lock-")));
    const token = randomUUID();
    const jobs = [];
    try {
      writeFileSync(join(dir, ".bench-parent.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      for (const sub of [AGENT, "home", "tmp"]) mkdirSync(join(dir, sub));
      const env = { PATH: process.env.PATH, HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"),
        TMP: join(dir, "tmp"), TEMP: join(dir, "tmp"), TPS_BENCH_TOKEN: token };
      const add = (role, id, extra = {}) => {
        const out = join(dir, `${id}.json`);
        const ready = join(dir, `${id}.ready`);
        const job = launch(role, { env, flags: { dir, out, ready, go: join(dir, "go"), ...extra } }, timeoutMs);
        Object.assign(job, { role, out, ready });
        job.done.then((status) => { job.status = status; });
        jobs.push(job);
        return job;
      };
      const watcher = add("watch", "watch", { stop: join(dir, "stop") });
      const writers = Array.from({ length: n }, (_, i) => add("writer", `writer-${i}`, { writes }));
      const sweeper = add("sweeper", "sweeper", { sweeps, seed, ...(holder === undefined ? {} : { holder }) });
      const deadline = Date.now() + timeoutMs;
      while (!jobs.every((j) => existsSync(j.ready))) {
        if (jobs.some((j) => j.status) || Date.now() >= deadline) throw new Error("barrier failed");
        await pause(1);
      }
      writeFileSync(join(dir, "go"), "go", { flag: "wx" });
      const statuses = await Promise.all([...writers, sweeper].map((j) => j.done));
      writeFileSync(join(dir, "stop"), "stop", { flag: "wx" });
      statuses.push(await watcher.done);
      for (const s of statuses) if (s.code !== 0 || s.timedOut) throw new Error(`child failed: ${JSON.stringify(s)}`);
      for (const job of [...writers, sweeper]) {
        const r = JSON.parse(readFileSync(job.out, "utf8"));
        const count = job.role === "writer" ? writes * 3 : sweeps;
        samples(r.waits, count, "acquisition");
        samples(r.calls, count, "call");
        if (r.errors !== 0 || r.failed !== 0 || r.acquisitions !== count || !Number.isSafeInteger(r.collisions) || r.collisions < 0) {
          throw new Error("invalid acquisition counts");
        }
        if (job.role === "writer") {
          result.writerWaits.push(...r.waits);
          result.writerCalls.push(...r.calls);
          result.writerAcquisitions += r.acquisitions;
          result.writerCollisions += r.collisions;
        } else {
          if (holder === undefined && (!Array.isArray(r.removals) || r.removals.length !== sweeps || r.removals.some((v) => v !== seed))) {
            throw new Error("invalid sweep removals");
          }
          result.sweepCalls.push(...r.calls);
          result.sweepAcquisitions += r.acquisitions;
          result.sweepCollisions += r.collisions;
        }
      }
      const spans = JSON.parse(readFileSync(watcher.out, "utf8"));
      if (!Array.isArray(spans) || spans.some((s) => !Number.isSafeInteger(s.pid) || !Number.isFinite(s.ms) || s.ms < 0)) {
        throw new Error("invalid watcher data");
      }
      const holds = spans.filter((s) => s.pid === sweeper.pid).map((s) => s.ms);
      if (!holds.length) throw new Error("missing sweep hold observations");
      result.sweepHolds.push(...holds);
    } finally {
      for (const j of jobs) if (!j.status) j.child.kill("SIGKILL");
      await Promise.all(jobs.map((j) => j.done));
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return result;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => {
    const index = p / 100 * (sorted.length - 1);
    const lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  };
  return { n: sorted.length, p50: percentile(50), p95: percentile(95), p99: percentile(99), max: sorted.at(-1) };
}

async function main() {
  if (F.nowatch !== undefined) throw new Error("watcher required");
  const ns = (F.n ?? "1,4,16").split(",").map(Number);
  if (!ns.length || ns.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("invalid --n");
  const writes = positive("writes", 10), sweeps = positive("sweeps", 8), seed = positive("seed", 200);
  const target = positive("target", 1500), timeoutMs = Number(F.timeout ?? 120) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");
  const results = {};
  for (const n of ns) {
    const rounds = positive("rounds", Math.max(Math.ceil(target / (n * 3 * writes)), Math.ceil(120 / sweeps)));
    const r = await measure(n, rounds, writes, sweeps, seed, timeoutMs, F.holder);
    results[n] = { rounds, writerLockWaitMs: stats(r.writerWaits), wholeWriteLatencyMs: stats(r.writerCalls),
      sampledSweepOwnerSpanMs: stats(r.sweepHolds), sweepCallLatencyMs: stats(r.sweepCalls),
      writerAcquisitions: r.writerAcquisitions, writerCollisions: r.writerCollisions,
      sweepAcquisitions: r.sweepAcquisitions, sweepCollisions: r.sweepCollisions };
  }
  for (const [n, r] of Object.entries(results)) console.log(`N=${n} ${JSON.stringify(r)}`);
  if (F.json) console.log(`JSON ${JSON.stringify(results)}`);
}

if (ENTRY) {
  try {
    if (F.role) await roleMain();
    else await main();
  } catch (err) {
    console.error(String(err));
    process.exitCode = 1;
  }
}
