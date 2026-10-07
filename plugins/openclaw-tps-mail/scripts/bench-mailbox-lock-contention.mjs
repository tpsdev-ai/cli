#!/usr/bin/env bun
/**
 * bench-mailbox-lock-contention.mjs
 *
 * Measures contention on the per-mailbox lock (packages/agent/src/lib/mail-lock.ts)
 * between the aged-nack retention sweep (`sweepTerminalObligations`, cli#534) and
 * concurrent obligation writers in this plugin.
 *
 * It is a REAL-FILE benchmark, not a unit test: it builds a real mailbox
 * directory on disk (obligation records + metadata receipts), runs the REAL
 * sweep and the REAL obligation writers in SEPARATE OS PROCESSES against that
 * one directory (the lock is inter-process), and records:
 *   - each writer's lock wait  — the wall time of one real obligation write call
 *     (write/create/transition), which is dominated by the lock wait because the
 *     critical-section work is a single small file rewrite;
 *   - each sweep's hold         — the wall time of one real sweep call.
 *
 * It prints p50 / p95 / p99 / max for N = 1, 4, 16 concurrent writers.
 *
 * This script is not part of the unit lane (that lane runs test/ through
 * scripts/run-tests.mjs); run it by hand:
 *
 *   bun plugins/openclaw-tps-mail/scripts/bench-mailbox-lock-contention.mjs
 *
 * Flags (all optional):
 *   --n=1,4,16      writer counts to measure              (default 1,4,16)
 *   --writes=10     obligation-write iterations per writer per round
 *   --sweeps=8      sweep calls per sweeper per round
 *   --rounds=       rounds per writer count (default: auto to target samples)
 *   --seed=200      aged terminal records (+ receipts) seeded before each sweep
 *   --target=1500   target writer samples per writer count (auto rounds)
 *   --timeout=120   per-round wall-clock budget, seconds
 *   --json          also print the raw result object as JSON
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const obligations = await import(resolve(HERE, "../src/obligations.js"));
const { obligationsDir, receiptsDir, sweepTerminalObligations, writeObligation, createObligation, transitionObligation } = obligations;
const { acquireMailLockSync } = await import("@tpsdev-ai/agent");

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30; // records seeded ~200 days old are well past this
const AGENT = "agent-a"; // neutral fixture name (no real fleet host/agent)
const QUIET = { info: () => {}, warn: () => {} };

// ── argument parsing ─────────────────────────────────────────────────────────

function flags(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? "true" : m[2];
  }
  return out;
}

const F = flags(process.argv.slice(2));
const ROLE = F.role;
const num = (name, dflt) => (F[name] !== undefined ? Number(F[name]) : dflt);

// ── shared fixture helpers ───────────────────────────────────────────────────

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/** Write a file atomically (dot-free temp + rename) so a concurrent reader
 *  never parses a half-written record. */
function atomicWrite(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

function makeRecord(obligationId, inboundId, state, iso) {
  return {
    obligationId,
    inboundId,
    inboundTimestamp: iso,
    from: "sender-a",
    to: AGENT,
    accountId: "default",
    state,
    deadlineAt: null,
    attempts: state === "pending" ? 0 : 1,
    lastTransitionAt: iso,
  };
}

/**
 * Seed `n` aged terminal obligations and their metadata receipts, so a sweep
 * has real work to do (parse, unlink, receipt unlink). Written directly and
 * atomically: this is fixture setup, outside any measured call. Receipt files
 * carry the fields the sweep reads (`obligationId`, `ts`).
 */
function seedAgedBatch(mailDir, n, tag) {
  const od = obligationsDir(mailDir, AGENT);
  const rd = receiptsDir(mailDir, AGENT);
  mkdirSync(od, { recursive: true });
  mkdirSync(rd, { recursive: true });
  const old = new Date(Date.now() - 200 * DAY_MS).toISOString();
  for (let i = 0; i < n; i++) {
    const inboundId = `seed-${tag}-${i}`;
    const obligationId = `ob-${inboundId}`;
    atomicWrite(join(od, `${inboundId}.json`), JSON.stringify(makeRecord(obligationId, inboundId, "failed", old), null, 2));
    atomicWrite(
      join(rd, `${obligationId}.json`),
      JSON.stringify({ replyId: `reply-${obligationId}`, obligationId, replyToId: `thread-${inboundId}`, route: "local", ts: old, signedReply: "{}" }, null, 2),
    );
  }
}

// ── child roles ──────────────────────────────────────────────────────────────

async function roleWriter() {
  const mailDir = F.dir;
  const writes = num("writes", 10);
  const out = F.out;
  const waits = [];
  let busy = 0;
  let errors = 0;
  for (let j = 0; j < writes; j++) {
    const inboundId = `w-${process.pid}-${F.round}-${j}`;
    const obligationId = `ob-${inboundId}`;
    const iso = new Date().toISOString();
    let t0 = nowMs();
    try {
      createObligation(mailDir, AGENT, () => makeRecord(obligationId, inboundId, "pending", iso), QUIET);
      waits.push(nowMs() - t0);
    } catch (err) {
      if (String(err?.message ?? err).includes("busy")) busy++;
      else errors++;
    }
    t0 = nowMs();
    try {
      transitionObligation(mailDir, AGENT, inboundId, "delivering", {}, QUIET);
      waits.push(nowMs() - t0);
    } catch (err) {
      if (String(err?.message ?? err).includes("busy")) busy++;
      else errors++;
    }
    t0 = nowMs();
    try {
      writeObligation(mailDir, AGENT, makeRecord(obligationId, inboundId, "posted", iso));
      waits.push(nowMs() - t0);
    } catch (err) {
      if (String(err?.message ?? err).includes("busy")) busy++;
      else errors++;
    }
  }
  writeFileSync(out, JSON.stringify({ waits, busy, errors }), "utf-8");
}

async function roleSweeper() {
  const mailDir = F.dir;
  const sweeps = num("sweeps", 8);
  const seed = num("seed", 200);
  const out = F.out;
  const calls = [];
  let removed = 0;
  // --holder=<ms> runs a bare lock HOLDER (acquire, hold ms, release) instead of
  // the real sweep: it isolates how long the sweep HOLDS the lock from the
  // writers' wait, to show what the wait floor is (the lock's poll interval).
  const holderMs = F.holder !== undefined ? Number(F.holder) : null;
  for (let j = 0; j < sweeps; j++) {
    if (holderMs !== null) {
      const t0 = nowMs();
      const lock = acquireMailLockSync(resolve(mailDir, AGENT), { timeoutMs: 0 });
      if (lock) {
        if (holderMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holderMs);
        lock.release();
      }
      calls.push(nowMs() - t0);
      continue;
    }
    // Re-arm a full batch of aged debt so every timed sweep has real work.
    seedAgedBatch(mailDir, seed, `${F.round}-${j}`);
    const t0 = nowMs();
    const res = sweepTerminalObligations(mailDir, AGENT, RETENTION_DAYS, QUIET);
    calls.push(nowMs() - t0);
    removed += res.removed;
  }
  writeFileSync(out, JSON.stringify({ calls, removed }), "utf-8");
}

/**
 * Sample the mailbox lock's owner and record how long each holder holds it,
 * attributed by the owner pid. This measures the sweep's LOCK HOLD directly
 * (the sweeper's pid), independent of how much work runs outside the lock.
 * Sampled in a busy loop, so it is a benchmark-only observer (not production).
 */
async function roleWatch() {
  const dir = F.dir;
  const out = F.out;
  const stop = F.stop;
  const ownerPath = join(dir, AGENT, ".mail-lock", "owner.json");
  const spans = [];
  let cur = null;
  let start = 0;
  while (!existsSync(stop)) {
    let pid = null;
    try {
      const o = JSON.parse(readFileSync(ownerPath, "utf-8"));
      if (typeof o.pid === "number") pid = o.pid;
    } catch {
      // lock absent or owner unreadable
    }
    if (pid !== cur) {
      if (cur !== null) spans.push({ pid: cur, ms: nowMs() - start });
      cur = pid;
      start = nowMs();
    }
  }
  if (cur !== null) spans.push({ pid: cur, ms: nowMs() - start });
  writeFileSync(out, JSON.stringify(spans), "utf-8");
}

// ── orchestrator ─────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : Number.NaN,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : Number.NaN,
  };
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : "n/a");

/** Spawn one child (`bun <this> --role=…`); returns the child, its pid and a
 *  completion promise. */
function startChild(role, opts, timeoutMs) {
  const args = [fileURLToPath(import.meta.url), `--role=${role}`, `--dir=${opts.dir}`, `--out=${opts.out}`, `--round=${opts.round}`];
  if (role === "writer") args.push(`--writes=${opts.writes}`);
  if (role === "sweeper") {
    args.push(`--sweeps=${opts.sweeps}`, `--seed=${opts.seed}`);
    if (opts.holder !== undefined) args.push(`--holder=${opts.holder}`);
  }
  if (role === "watch") args.push(`--stop=${opts.stop}`);
  const env = { ...process.env, HOME: opts.home, TMPDIR: opts.tmp };
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      res({ timedOut: true, stderr });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      res({ code, timedOut: false, stderr });
    });
  });
  return { child, pid: child.pid, done };
}

async function measure(nWriters, rounds, writes, sweeps, seed, perRoundTimeoutMs, useWatcher) {
  const writerWaits = [];
  const sweepCalls = [];
  const sweepHolds = [];
  let busy = 0;
  let errors = 0;
  let timeouts = 0;
  const home = mkdtempSync(join(tmpdir(), "bench-lock-home-"));
  for (let round = 0; round < rounds; round++) {
    const dir = mkdtempSync(join(tmpdir(), "bench-lock-mail-"));
    const tmp = join(dir, "tmp");
    mkdirSync(tmp, { recursive: true });
    const outputs = [];
    const jobs = [];
    for (let w = 0; w < nWriters; w++) {
      const out = join(dir, `writer-${w}.json`);
      outputs.push({ role: "writer", out });
      jobs.push(startChild("writer", { dir, out, round, writes, home, tmp }, perRoundTimeoutMs));
    }
    const sweepOut = join(dir, "sweeper.json");
    outputs.push({ role: "sweeper", out: sweepOut });
    const sweeper = startChild("sweeper", { dir, out: sweepOut, round, sweeps, seed, holder: F.holder, home, tmp }, perRoundTimeoutMs);
    jobs.push(sweeper);

    const stop = join(dir, "watch.stop");
    const watchOut = join(dir, "watch.json");
    const watcher = useWatcher ? startChild("watch", { dir, out: watchOut, round, stop, home, tmp }, perRoundTimeoutMs) : null;

    const done = await Promise.all(jobs.map((j) => j.done));
    for (const d of done) if (d.timedOut) timeouts++;
    if (watcher) {
      writeFileSync(stop, "stop");
      await watcher.done;
    }

    for (const { role, out } of outputs) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(out, "utf-8")); } catch { continue; }
      if (role === "writer") { writerWaits.push(...parsed.waits); busy += parsed.busy ?? 0; errors += parsed.errors ?? 0; }
      else sweepCalls.push(...parsed.calls);
    }
    if (watcher) {
      try {
        const spans = JSON.parse(readFileSync(watchOut, "utf-8"));
        for (const s of spans) if (s.pid === sweeper.pid) sweepHolds.push(s.ms);
      } catch { /* watcher produced nothing */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
  return { writerWaits, sweepCalls, sweepHolds, busy, errors, timeouts };
}

async function main() {
  const ns = (F.n ?? "1,4,16").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
  const writes = num("writes", 10);
  const sweeps = num("sweeps", 8);
  const seed = num("seed", 200);
  const target = num("target", 1500);
  const perRoundTimeoutMs = num("timeout", 120) * 1000;

  console.log(`bench-mailbox-lock-contention: writes=${writes}/writer/round, sweeps=${sweeps}/sweeper/round, seed=${seed}${F.holder !== undefined ? `, holder=${F.holder}ms` : ""}`);
  console.log("lock wait = wall time of one real obligation write call; hold = wall time of one real sweep call\n");

  const useWatcher = F.nowatch === undefined;
  const results = {};
  for (const n of ns) {
    const rounds = num("rounds", Math.max(Math.ceil(target / (n * 3 * writes)), Math.ceil(120 / sweeps)));
    const r = await measure(n, rounds, writes, sweeps, seed, perRoundTimeoutMs, useWatcher);
    const w = stats(r.writerWaits);
    const s = stats(r.sweepHolds);
    const c = stats(r.sweepCalls);
    results[n] = { rounds, writers: n, wait: w, hold: s, call: c, busy: r.busy, errors: r.errors, timeouts: r.timeouts };
    console.log(
      `N=${n}  (${rounds} rounds)  writer lock wait ms: n=${w.n} p50=${fmt(w.p50)} p95=${fmt(w.p95)} p99=${fmt(w.p99)} max=${fmt(w.max)} mean=${fmt(w.mean)}` +
        `   |   sweep LOCK HOLD ms: n=${s.n} p50=${fmt(s.p50)} p95=${fmt(s.p95)} p99=${fmt(s.p99)} max=${fmt(s.max)}` +
        `   |   sweep call ms: p50=${fmt(c.p50)} p99=${fmt(c.p99)}` +
        (r.busy || r.errors || r.timeouts ? `   | busy=${r.busy} errors=${r.errors} roundTimeouts=${r.timeouts}` : ""),
    );
  }

  if (F.json) console.log(`\nJSON ${JSON.stringify(results)}`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

if (ROLE === "writer") await roleWriter();
else if (ROLE === "sweeper") await roleSweeper();
else if (ROLE === "watch") await roleWatch();
else await main();
