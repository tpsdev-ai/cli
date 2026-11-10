import { isMailboxMessageFile } from "@tpsdev-ai/agent";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { type MailLock, tryAcquireMailLock } from "./mail-lock.js";

export class OutboxLockError extends Error {
  constructor(lockPath: string, cause: unknown) {
    super(`OutboxLockError: ${lockPath}: ${(cause as Error).message}`, { cause });
    this.name = "OutboxLockError";
  }
}

export interface OutboxMessage {
  id: string;
  to: string;
  from: string;
  body: string;
  timestamp: string;
}

function outboxDir(kind: "new" | "sent"): string {
  return join(process.env.HOME || homedir(), ".tps", "outbox", kind);
}

export type QueueOutboxResult = "queued" | "duplicate" | "duplicate in progress";

export function queueOutboxMessage(to: string, body: string, from: string, deliveryId?: string): QueueOutboxResult {
  return queue(to, body, from, deliveryId, false).result;
}

/** With a delivery ID, pending claims hold the lock until unlock(). */
export function claimOutboxDelivery(to: string, body: string, from: string, deliveryId?: string): { result: "pending" | "duplicate" | "duplicate in progress"; complete: () => void; unlock: () => void } {
  const { result, lock, complete } = queue(to, body, from, deliveryId, true);
  return {
    result: result === "queued" ? "pending" : result,
    complete: complete ?? (() => {}),
    unlock: () => {
      try {
        lock?.release();
      } catch (error) {
        throw new OutboxLockError(outboxLockPath(deliveryId!), error);
      }
    },
  };
}

/** Removes this delivery's record from new/ and sent/. */
export function releaseOutboxRecord(deliveryId: string): void {
  if (!/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error("invalid outbox delivery id");
  for (const kind of ["new", "sent"] as const) {
    for (const prefix of ["github", "github-completed"]) {
      rmSync(join(outboxDir(kind), `${prefix}-${deliveryId}.json`), { force: true });
    }
  }
}

function outboxLockPath(deliveryId: string): string {
  return join(outboxDir("new"), `.github-${deliveryId}.lock`);
}

function recordExists(path: string): boolean {
  // One read, not stat-then-read: a concurrent drain can move the record between two calls, and
  // the second call's ENOENT would surface as an error instead of "not there".
  try {
    readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
}

function queue(to: string, body: string, from: string, deliveryId: string | undefined, deferWrite: boolean): { result: QueueOutboxResult; lock?: MailLock; complete?: () => void } {
  if (deliveryId !== undefined && !/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error("invalid outbox delivery id");
  const dir = outboxDir("new");
  mkdirSync(dir, { recursive: true });
  const lockPath = deliveryId ? outboxLockPath(deliveryId) : undefined;
  let lock: MailLock | null | undefined;
  if (lockPath) {
    try {
      lock = tryAcquireMailLock(lockPath);
    } catch (error) {
      throw new OutboxLockError(lockPath, error);
    }
    if (!lock) return { result: "duplicate in progress" };
  }
  const id = deliveryId ?? randomUUID();
  const timestamp = new Date().toISOString();
  const filename = deliveryId ? `${deferWrite ? "github-completed" : "github"}-${deliveryId}.json` : `${timestamp.replace(/[:.]/g, "-")}-${id}.json`;
  let alreadyRecorded = false;
  const write = (): void => {
    const content = JSON.stringify({ id, to, from, body, timestamp }, null, 2);
    const tmp = join(dir, `.${filename}-${randomUUID()}.tmp`);
    writeFileSync(tmp, content, "utf-8");
    if (deliveryId) {
      try {
        linkSync(tmp, join(dir, filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        unlinkSync(tmp);
      }
    } else {
      renameSync(tmp, join(dir, filename));
    }
  };
  let writeFailed = false;
  let writeError: unknown;
  try {
    alreadyRecorded = !!deliveryId && (recordExists(join(dir, filename)) || recordExists(join(outboxDir("sent"), filename)));
    if (deferWrite && !alreadyRecorded) return { result: "queued", lock: lock ?? undefined, complete: write };
    if (!alreadyRecorded) write();
  } catch (error) {
    writeFailed = true;
    writeError = error;
  }
  if (lock) {
    try {
      lock.release();
    } catch (error) {
      // When the write itself failed, its error is the one the caller needs.
      if (!writeFailed) throw new OutboxLockError(lockPath!, error);
    }
  }
  if (writeFailed) throw writeError;
  return { result: alreadyRecorded ? "duplicate" : "queued" };
}

/**
 * A file whose age is between 0 and this value that does not parse is treated
 * as a writer still in flight, not a bad record. A negative age (mtime in the
 * future) is treated as old.
 */
export const OUTBOX_PARTIAL_GRACE_MS = 5_000;

export interface OutboxDrainResult {
  messages: OutboxMessage[];
  /** Unparseable files left in place because they are younger than the grace. */
  skippedYoung: number;
}

export function drainOutbox(archive = true): OutboxMessage[] {
  return drainOutboxWithStats(archive).messages;
}

export function drainOutboxWithStats(archive = true): OutboxDrainResult {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(newDir, { recursive: true });
  mkdirSync(sentDir, { recursive: true });

  const files = readdirSync(newDir).filter(isMailboxMessageFile);
  const out: OutboxMessage[] = [];
  let skippedYoung = 0;
  for (const f of files) {
    const src = join(newDir, f);
    let msg: OutboxMessage;
    let raw: string;
    try {
      raw = readFileSync(src, "utf-8");
    } catch (err) {
      console.error(`drainOutbox: failed to read ${f}: ${(err as Error).message}; leaving in place`);
      continue;
    }
    try {
      msg = JSON.parse(raw) as OutboxMessage;
    } catch (err) {
      let ageMs: number;
      try {
        ageMs = Math.round(Date.now() - statSync(src).mtimeMs);
      } catch (statErr) {
        console.error(`drainOutbox: failed to stat ${f}: ${(statErr as Error).message}; leaving in place`);
        continue;
      }
      // A writer that is still writing publishes a short, unparseable file.
      // Leave it for the next pass; quarantine once it has had the grace period
      // and still does not parse, or straight away when its mtime is in the
      // future (a negative age is not a writer in flight).
      if (ageMs >= 0 && ageMs < OUTBOX_PARTIAL_GRACE_MS) {
        console.error(`drainOutbox: failed to parse ${f} (age ${ageMs}ms): younger than ${OUTBOX_PARTIAL_GRACE_MS}ms; leaving in place`);
        skippedYoung++;
        continue;
      }
      console.error(`drainOutbox: failed to parse ${f} (age ${ageMs}ms): quarantining`);
      try {
        renameSync(src, join(sentDir, `.malformed-${f}`));
      } catch {
        try { unlinkSync(src); } catch {}
      }
      continue;
    }
    if (archive) renameSync(src, join(sentDir, f));
    out.push(msg);
  }
  return { messages: out, skippedYoung };
}

export function acknowledgeOutbox(id: string): void {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(sentDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  for (const filename of readdirSync(newDir).filter(isMailboxMessageFile)) {
    const path = join(newDir, filename);
    let record: OutboxMessage;
    try {
      record = JSON.parse(readFileSync(path, "utf-8")) as OutboxMessage;
    } catch (err) {
      console.error(`acknowledgeOutbox: skipping ${filename}: ${(err as Error).message}`);
      continue;
    }
    if (record.id === id) renameSync(path, join(sentDir, filename));
  }
}

export const OUTBOX_RESEND_BASE_MS = 60_000;
export const OUTBOX_MAX_SENDS = 5;

export interface OutboxSendPass {
  messages: OutboxMessage[];
  skippedYoung: number;
}

export class OutboxSendTracker {
  private readonly sends = new Map<string, { at: number; count: number }>();

  due(now = Date.now()): OutboxMessage[] {
    return this.dueWithStats(now).messages;
  }

  dueWithStats(now = Date.now()): OutboxSendPass {
    const { messages, skippedYoung } = drainOutboxWithStats(false);
    const out: OutboxMessage[] = [];
    for (const item of messages) {
      const prev = this.sends.get(item.id);
      if (prev && prev.count >= OUTBOX_MAX_SENDS) continue;
      if (prev && now - prev.at < OUTBOX_RESEND_BASE_MS * 2 ** (prev.count - 1)) continue;
      const count = (prev?.count ?? 0) + 1;
      this.sends.set(item.id, { at: now, count });
      if (count === OUTBOX_MAX_SENDS) console.error(`outbox: ${item.id} sent ${count} times without an ACK; not resending until restart`);
      out.push(item);
    }
    return { messages: out, skippedYoung };
  }

  sendFailed(id: string): void {
    const prev = this.sends.get(id);
    if (!prev) return;
    if (prev.count <= 1) this.sends.delete(id);
    else this.sends.set(id, { at: 0, count: prev.count - 1 });
  }

  acknowledge(id: string): void {
    acknowledgeOutbox(id);
    this.sends.delete(id);
  }
}

/**
 * Schedules one retry when a send pass skipped a young unparseable file.
 * While a retry is pending, further skips schedule nothing. The timer is
 * unref'd so it does not hold the process open.
 */
export class OutboxYoungRetryScheduler {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
    private readonly delayMs: number = OUTBOX_PARTIAL_GRACE_MS,
  ) {}

  get pending(): boolean {
    return this.handle !== null;
  }

  observe(skippedYoung: number, run: () => void): void {
    if (this.stopped || skippedYoung <= 0 || this.handle !== null) return;
    const handle = this.setTimer(() => {
      this.handle = null;
      run();
    }, this.delayMs);
    this.handle = handle;
    (handle as unknown as { unref?: () => void }).unref?.();
  }

  cancel(): void {
    this.stopped = true;
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }
}

export interface OutboxSendPassOptions<T> {
  tracker: OutboxSendTracker;
  scheduler: OutboxYoungRetryScheduler;
  /** Channel this pass sends on. */
  target: T;
  /** Wire sequence number for this pass. */
  seq: number;
  /** Delivers one drained record on `target`; a rejection fails that record. */
  send: (target: T, item: OutboxMessage, seq: number) => Promise<unknown> | void;
  /**
   * The channel a scheduled retry may use, or null when none is alive. A retry
   * runs on seq 0: it belongs to no inbound message, and the outbox watcher
   * uses 0 for the same reason.
   */
  pickTarget: () => T | null;
  onRetryError?: (error: unknown) => void;
}

/**
 * One send pass: drain, deliver, and schedule a single retry if a pass skipped
 * a young unparseable file. The retry is how that file gets another pass
 * without another directory event.
 */
export async function runOutboxSendPass<T>(options: OutboxSendPassOptions<T>): Promise<void> {
  const { tracker, scheduler, target, seq, send, pickTarget, onRetryError } = options;
  const pass = tracker.dueWithStats();
  for (const item of pass.messages) {
    try {
      await send(target, item, seq);
    } catch {
      tracker.sendFailed(item.id);
    }
  }
  scheduler.observe(pass.skippedYoung, () => {
    const retryTarget = pickTarget();
    if (retryTarget === null) return;
    void runOutboxSendPass({ ...options, target: retryTarget, seq: 0 }).catch((error) => onRetryError?.(error));
  });
}
