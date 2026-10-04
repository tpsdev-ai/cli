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
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  readFileSync(path);
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

export function drainOutbox(archive = true): OutboxMessage[] {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(newDir, { recursive: true });
  mkdirSync(sentDir, { recursive: true });

  const files = readdirSync(newDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const out: OutboxMessage[] = [];
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
      // Defense-in-depth: even with atomic writes, a partial file could appear
      // (manual edit, crash mid-write before rename). Don't take the whole
      // daemon down — log and quarantine the bad file.
      console.error(`drainOutbox: failed to parse ${f}: ${(err as Error).message}; quarantining`);
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
  return out;
}

export function acknowledgeOutbox(id: string): void {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(sentDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  for (const filename of readdirSync(newDir).filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
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

export class OutboxSendTracker {
  private readonly sends = new Map<string, { at: number; count: number }>();

  due(now = Date.now()): OutboxMessage[] {
    const out: OutboxMessage[] = [];
    for (const item of drainOutbox(false)) {
      const prev = this.sends.get(item.id);
      if (prev && prev.count >= OUTBOX_MAX_SENDS) continue;
      if (prev && now - prev.at < OUTBOX_RESEND_BASE_MS * 2 ** (prev.count - 1)) continue;
      const count = (prev?.count ?? 0) + 1;
      this.sends.set(item.id, { at: now, count });
      if (count === OUTBOX_MAX_SENDS) console.error(`outbox: ${item.id} sent ${count} times without an ACK; not resending until restart`);
      out.push(item);
    }
    return out;
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
