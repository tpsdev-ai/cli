import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueOutboxMessage, drainOutbox, drainOutboxWithStats, OUTBOX_FUTURE_SKEW_MS, releaseOutboxRecord, acknowledgeOutbox, OutboxSendTracker, OutboxYoungRetryScheduler, OUTBOX_MAX_SENDS, OUTBOX_RESEND_BASE_MS, OUTBOX_PARTIAL_GRACE_MS, runOutboxSendPass } from "../src/utils/outbox.js";
import * as mailLock from "../src/utils/mail-lock.js";

afterEach(() => {
  mock.restore();
});

describe("outbox", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-outbox-"));
    process.env.HOME = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test("queueOutboxMessage writes to ~/.tps/outbox/new", () => {
    queueOutboxMessage("host", "hello", "austin");
    const files = readdirSync(join(root, ".tps", "outbox", "new"));
    expect(files.length).toBe(1);
  });

  test("queueOutboxMessage leaves no dot-prefixed tmp files after a successful write", () => {
    queueOutboxMessage("host", "hello", "austin");
    const all = readdirSync(join(root, ".tps", "outbox", "new"));
    expect(all.every((f) => !f.startsWith("."))).toBe(true);
  });

  test("drainOutbox returns messages and moves files to sent", () => {
    queueOutboxMessage("host", "hello", "austin");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.to).toBe("host");

    const newFiles = readdirSync(join(root, ".tps", "outbox", "new"));
    const sentFiles = readdirSync(join(root, ".tps", "outbox", "sent"));
    expect(newFiles.length).toBe(0);
    expect(sentFiles.length).toBe(1);
  });

  test("drainOutbox ignores dot-prefixed in-flight tmp files (atomic-write race guard)", () => {
    // Simulate a writer that's mid-write: a dot-tmp file exists but the
    // final rename hasn't happened yet. drainOutbox must not try to parse it.
    const newDir = join(root, ".tps", "outbox", "new");
    queueOutboxMessage("host", "hello", "austin");
    writeFileSync(join(newDir, ".pending.json.tmp"), "{ partial", "utf-8");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.body).toBe("hello");
    // The in-flight tmp file is untouched
    expect(existsSync(join(newDir, ".pending.json.tmp"))).toBe(true);
  });

  test("drainOutbox quarantines malformed JSON without throwing (defense in depth)", () => {
    // Inject a fully-published-but-corrupt file (not dot-prefixed) and prove
    // the daemon-equivalent loop doesn't crash. Pre-fix, this threw SyntaxError
    // and killed the branch daemon on tps-reed 2026-05-16T17:17Z.
    const newDir = join(root, ".tps", "outbox", "new");
    const sentDir = join(root, ".tps", "outbox", "sent");
    queueOutboxMessage("host", "good", "austin");
    const corrupt = join(newDir, "2026-05-16-corrupt.json");
    writeFileSync(corrupt, "", "utf-8");
    const past = new Date(Date.now() - 10_000);
    utimesSync(corrupt, past, past);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows = drainOutbox();
      expect(rows.length).toBe(1);
      expect(rows[0]?.body).toBe("good");
      expect(readdirSync(newDir).length).toBe(0);
      // Bad file lands in sent/ with a .malformed- prefix for forensics
      expect(readdirSync(sentDir).some((f) => f.startsWith(".malformed-"))).toBe(true);
      const logs = errors.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logs).toMatch(/failed to parse 2026-05-16-corrupt\.json \(age \d+ms\): quarantining/);
    } finally {
      errors.mockRestore();
    }
  });

  test("a young empty file is skipped, then returned once after it is complete and never quarantined", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    const sentDir = join(root, ".tps", "outbox", "sent");
    const name = "2026-05-16-partial.json";
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, name), "", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(drainOutbox()).toEqual([]);
      expect(existsSync(join(newDir, name))).toBe(true);
      expect(existsSync(join(sentDir, `.malformed-${name}`))).toBe(false);

      writeFileSync(
        join(newDir, name),
        JSON.stringify({ id: "partial-1", to: "host", from: "agent", body: "complete", timestamp: new Date().toISOString() }),
        "utf-8",
      );
      expect(drainOutbox().map((m) => m.id)).toEqual(["partial-1"]);
      expect(drainOutbox()).toEqual([]);
      expect(existsSync(join(sentDir, `.malformed-${name}`))).toBe(false);
      expect(existsSync(join(sentDir, name))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("a valid file is returned on the first pass in both archive modes", () => {
    queueOutboxMessage("host", "archived", "agent");
    expect(drainOutbox(true).map((m) => m.body)).toEqual(["archived"]);
    queueOutboxMessage("host", "kept", "agent");
    expect(drainOutbox(false).map((m) => m.body)).toEqual(["kept"]);
  });

  test("a pass that skips a young file schedules one re-run and no second timer while it is pending", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "young.json"), "{", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const scheduler = new OutboxYoungRetryScheduler(
      (fn, ms) => {
        timers.push({ fn, ms });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      () => {},
    );
    try {
      let runs = 0;
      const first = drainOutboxWithStats(false);
      expect(first.skippedYoung).toBe(1);
      scheduler.observe(first.skippedYoung, () => { runs += 1; });
      expect(timers).toHaveLength(1);
      expect(timers[0]!.ms).toBe(OUTBOX_PARTIAL_GRACE_MS);

      const second = drainOutboxWithStats(false);
      expect(second.skippedYoung).toBe(1);
      scheduler.observe(second.skippedYoung, () => { runs += 1; });
      expect(timers).toHaveLength(1);

      timers[0]!.fn();
      expect(runs).toBe(1);
      expect(scheduler.pending).toBe(false);

      scheduler.observe(1, () => { runs += 1; });
      expect(timers).toHaveLength(2);
    } finally {
      scheduler.cancel();
      errors.mockRestore();
    }
  });

  test("drainOutbox leaves a source it cannot read in place", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    queueOutboxMessage("host", "good", "austin");
    mkdirSync(join(newDir, "unreadable.json"));
    const rows = drainOutbox(false);
    expect(rows.length).toBe(1);
    expect(existsSync(join(newDir, "unreadable.json"))).toBe(true);
    expect(existsSync(join(root, ".tps", "outbox", "sent", ".malformed-unreadable.json"))).toBe(false);
  });

  test("acknowledgeOutbox skips an unreadable or corrupt entry and still archives the acknowledged record", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    queueOutboxMessage("host", "good", "austin");
    const [record] = drainOutbox(false);
    mkdirSync(join(newDir, "unreadable.json"));
    writeFileSync(join(newDir, "corrupt.json"), "{", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      acknowledgeOutbox(record!.id);
    } finally {
      errors.mockRestore();
    }
    expect(readdirSync(newDir).sort()).toEqual(["corrupt.json", "unreadable.json"]);
    expect(readdirSync(join(root, ".tps", "outbox", "sent")).length).toBe(1);
  });

  test("OutboxSendTracker sends a pending record once until its resend time, and stops after the max", () => {
    queueOutboxMessage("host", "once", "austin");
    const tracker = new OutboxSendTracker();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      let now = 1_000_000;
      expect(tracker.due(now).length).toBe(1);
      expect(tracker.due(now)).toEqual([]);
      expect(tracker.due(now + OUTBOX_RESEND_BASE_MS - 1)).toEqual([]);
      let sends = 1;
      for (let i = 0; i < 20; i++) {
        now += OUTBOX_RESEND_BASE_MS * 2 ** 10;
        sends += tracker.due(now).length;
      }
      expect(sends).toBe(OUTBOX_MAX_SENDS);
      expect(drainOutbox(false).length).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("OutboxSendTracker resends after a failed send and forgets an acknowledged record", () => {
    queueOutboxMessage("host", "retry", "austin");
    const tracker = new OutboxSendTracker();
    const [item] = tracker.due(0);
    tracker.sendFailed(item!.id);
    expect(tracker.due(0).map((m) => m.id)).toEqual([item!.id]);
    tracker.acknowledge(item!.id);
    expect(drainOutbox(false)).toEqual([]);
    expect(tracker.due(OUTBOX_RESEND_BASE_MS * 100)).toEqual([]);
  });

  test("concurrent redelivery and drain enqueue a delivery only once", async () => {
    const modulePath = new URL("../src/utils/outbox.ts", import.meta.url).pathname;
    const id = "a".repeat(64);
    const producers = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", `
      import { queueOutboxMessage } from ${JSON.stringify(modulePath)};
      queueOutboxMessage("host", "body", "github-webhook", ${JSON.stringify(id)});
    `], { env: process.env, stdout: "pipe", stderr: "pipe" }));
    const drainer = Bun.spawn([process.execPath, "-e", `
      import { drainOutbox } from ${JSON.stringify(modulePath)};
      let count = 0;
      for (let i = 0; i < 100; i++) { count += drainOutbox().length; await Bun.sleep(2); }
      console.log(count);
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    for (const producer of producers) {
      const error = await new Response(producer.stderr).text();
      expect(await producer.exited, error).toBe(0);
    }
    const count = Number(await new Response(drainer.stdout).text());
    const error = await new Response(drainer.stderr).text();
    expect(await drainer.exited, error).toBe(0);
    expect(count + drainOutbox().length).toBe(1);
    queueOutboxMessage("host", "body", "github-webhook", id);
    expect(drainOutbox()).toEqual([]);
  });

  test("queueing tolerates ENOENT for new/ when sent/ has the record", () => {
    const id = "a".repeat(64);
    const lock = spyOn(mailLock, "tryAcquireMailLock").mockReturnValue({ release() {} });
    try {
      expect(queueOutboxMessage("host", "hello", "austin", id)).toBe("queued");
      const newDir = join(root, ".tps", "outbox", "new");
      const sentDir = join(root, ".tps", "outbox", "sent");
      const name = `github-${id}.json`;
      mkdirSync(sentDir, { recursive: true });
      const original = fs.readFileSync;
      const read = spyOn(fs, "readFileSync").mockImplementation(((...args: any[]) => {
        if (String(args[0]) === join(newDir, name)) fs.renameSync(join(newDir, name), join(sentDir, name));
        return (original as any)(...args);
      }) as any);
      try {
        expect(queueOutboxMessage("host", "hello", "austin", id)).toBe("duplicate");
        expect(existsSync(join(sentDir, name))).toBe(true);
      } finally {
        read.mockRestore();
      }
    } finally {
      lock.mockRestore();
    }
  });

  test("an mtime slightly in the future (within the skew tolerance) is treated as young", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    const sentDir = join(root, ".tps", "outbox", "sent");
    mkdirSync(newDir, { recursive: true });
    const name = "2026-05-16-skew.json";
    writeFileSync(join(newDir, name), "{", "utf-8");
    const ahead = new Date(Date.now() + OUTBOX_FUTURE_SKEW_MS / 2);
    utimesSync(join(newDir, name), ahead, ahead);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A writer in flight can stamp an mtime just ahead of the drain's clock read.
      const result = drainOutboxWithStats(false);
      expect(result.skippedYoung).toBe(1);
      expect(result.messages).toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(existsSync(join(newDir, name))).toBe(true);
    expect(existsSync(join(sentDir, `.malformed-${name}`))).toBe(false);
  });

  test("a file with an mtime in the future is treated as old and quarantined", () => {
    const newDir = join(root, ".tps", "outbox", "new");
    const sentDir = join(root, ".tps", "outbox", "sent");
    mkdirSync(newDir, { recursive: true });
    const name = "2026-05-16-future.json";
    writeFileSync(join(newDir, name), "{", "utf-8");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(newDir, name), future, future);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      // No writer can hold a file young by setting a future mtime.
      const result = drainOutboxWithStats(false);
      expect(result.skippedYoung).toBe(0);
      expect(result.messages).toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(existsSync(join(sentDir, `.malformed-${name}`))).toBe(true);
    expect(existsSync(join(newDir, name))).toBe(false);
  });

  test("a real timer runs the retry once after the delay, and cancel() suppresses it", async () => {
    const scheduler = new OutboxYoungRetryScheduler(undefined, undefined, 20);
    let runs = 0;
    scheduler.observe(1, () => { runs += 1; });
    expect(scheduler.pending).toBe(true);
    await Bun.sleep(80);
    expect(runs).toBe(1);
    expect(scheduler.pending).toBe(false);

    const second = new OutboxYoungRetryScheduler(undefined, undefined, 20);
    let runsAfterCancel = 0;
    second.observe(1, () => { runsAfterCancel += 1; });
    second.cancel();
    await Bun.sleep(80);
    expect(runsAfterCancel).toBe(0);
  });

  test("observe() after cancel() schedules nothing", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const scheduler = new OutboxYoungRetryScheduler(
      (fn, ms) => {
        timers.push({ fn, ms });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      () => {},
    );
    scheduler.cancel();
    scheduler.observe(1, () => {});
    expect(timers).toHaveLength(0);
    expect(scheduler.pending).toBe(false);
  });

  test("runOutboxSendPass leaves a young file, then its retry sends it once on seq 0", async () => {
    const newDir = join(root, ".tps", "outbox", "new");
    mkdirSync(newDir, { recursive: true });
    const name = "young-relay.json";
    writeFileSync(join(newDir, name), "{", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const sent: Array<{ id: string; seq: number }> = [];
    const tracker = new OutboxSendTracker();
    const scheduler = new OutboxYoungRetryScheduler(undefined, undefined, 20);
    const target = { name: "host-a" };
    try {
      await runOutboxSendPass({
        tracker,
        scheduler,
        target,
        seq: 42,
        send: (_target, item, seq) => { sent.push({ id: item.id, seq }); },
        pickTarget: () => target,
      });
      expect(sent).toEqual([]);
      expect(scheduler.pending).toBe(true);

      writeFileSync(
        join(newDir, name),
        JSON.stringify({ id: "young-1", to: "host-a", from: "agent-a", body: "complete", timestamp: new Date().toISOString() }),
        "utf-8",
      );
      await Bun.sleep(80);
      // The retry belongs to no inbound message, so it does not reuse the pass's seq.
      expect(sent).toEqual([{ id: "young-1", seq: 0 }]);
      expect(scheduler.pending).toBe(false);
    } finally {
      scheduler.cancel();
      errors.mockRestore();
    }
  });

  test("runOutboxSendPass sends nothing when pickTarget returns null", async () => {
    const newDir = join(root, ".tps", "outbox", "new");
    mkdirSync(newDir, { recursive: true });
    const name = "young-null.json";
    writeFileSync(join(newDir, name), "{", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    const tracker = new OutboxSendTracker();
    const scheduler = new OutboxYoungRetryScheduler(undefined, undefined, 20);
    try {
      await runOutboxSendPass({
        tracker,
        scheduler,
        target: { name: "host-a" },
        seq: 0,
        send: (_target, item) => { sent.push(item.id); },
        pickTarget: () => null,
      });
      // The file is complete before the timer fires, so a retry that ran WOULD
      // have something to send.
      writeFileSync(
        join(newDir, name),
        JSON.stringify({ id: "young-3", to: "host-a", from: "agent-a", body: "complete", timestamp: new Date().toISOString() }),
        "utf-8",
      );
      await Bun.sleep(80);
      expect(sent).toEqual([]);
      expect(scheduler.pending).toBe(false);
    } finally {
      scheduler.cancel();
      errors.mockRestore();
    }
  });

  test("runOutboxSendPass sends nothing when cancelled before the retry fires", async () => {
    const newDir = join(root, ".tps", "outbox", "new");
    mkdirSync(newDir, { recursive: true });
    const name = "young-cancelled.json";
    writeFileSync(join(newDir, name), "{", "utf-8");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    const tracker = new OutboxSendTracker();
    const scheduler = new OutboxYoungRetryScheduler(undefined, undefined, 20);
    const target = { name: "host-a" };
    try {
      await runOutboxSendPass({
        tracker,
        scheduler,
        target,
        seq: 0,
        send: (_target, item) => { sent.push(item.id); },
        pickTarget: () => target,
      });
      writeFileSync(
        join(newDir, name),
        JSON.stringify({ id: "young-2", to: "host-a", from: "agent-a", body: "complete", timestamp: new Date().toISOString() }),
        "utf-8",
      );
      scheduler.cancel();
      await Bun.sleep(80);
      expect(sent).toEqual([]);
    } finally {
      scheduler.cancel();
      errors.mockRestore();
    }
  });

  test("releaseOutboxRecord removes only that delivery's record, from new/ or sent/", () => {
    const id = "b".repeat(64);
    const other = "c".repeat(64);
    expect(queueOutboxMessage("host", "body", "github-webhook", id)).toBe("queued");
    expect(drainOutbox()).toHaveLength(1);
    expect(queueOutboxMessage("host", "body", "github-webhook", other)).toBe("queued");
    releaseOutboxRecord(id);
    releaseOutboxRecord(other);
    expect(readdirSync(join(root, ".tps", "outbox", "sent"))).toEqual([]);
    expect(readdirSync(join(root, ".tps", "outbox", "new"))).toEqual([]);
    expect(queueOutboxMessage("host", "body", "github-webhook", id)).toBe("queued");
    expect(queueOutboxMessage("host", "body", "github-webhook", "d".repeat(64))).toBe("queued");
    releaseOutboxRecord(id);
    expect(readdirSync(join(root, ".tps", "outbox", "new"))).toEqual([`github-${"d".repeat(64)}.json`]);
  });

});
