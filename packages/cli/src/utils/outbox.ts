import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { tryAcquireMailLock } from "./mail-lock.js";

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

/** "queued" — this call wrote the record; "duplicate" — a record for this
 * delivery already exists (new/ or sent/), so an earlier call recorded it;
 * "duplicate in progress" — another writer holds the per-delivery lock. */
export type QueueOutboxResult = "queued" | "duplicate" | "duplicate in progress";

export function queueOutboxMessage(to: string, body: string, from: string, deliveryId?: string): QueueOutboxResult {
  if (deliveryId !== undefined && !/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error("invalid outbox delivery id");
  const dir = outboxDir("new");
  mkdirSync(dir, { recursive: true });
  const lockPath = deliveryId ? join(dir, `.github-${deliveryId}.lock`) : undefined;
  let lock;
  if (lockPath) {
    try {
      lock = tryAcquireMailLock(lockPath);
    } catch (error) {
      throw new OutboxLockError(lockPath, error);
    }
    if (!lock) return "duplicate in progress";
  }
  let alreadyRecorded = false;
  const write = (): void => {
    const id = deliveryId ?? randomUUID();
    const timestamp = new Date().toISOString();
    const filename = deliveryId ? `github-${deliveryId}.json` : `${timestamp.replace(/[:.]/g, "-")}-${id}.json`;
    if (deliveryId && (existsSync(join(dir, filename)) || existsSync(join(outboxDir("sent"), filename)))) {
      alreadyRecorded = true;
      return;
    }
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
    write();
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
  return alreadyRecorded ? "duplicate" : "queued";
}

export function drainOutbox(): OutboxMessage[] {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(newDir, { recursive: true });
  mkdirSync(sentDir, { recursive: true });

  const files = readdirSync(newDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const out: OutboxMessage[] = [];
  for (const f of files) {
    const src = join(newDir, f);
    let msg: OutboxMessage;
    try {
      msg = JSON.parse(readFileSync(src, "utf-8")) as OutboxMessage;
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
    renameSync(src, join(sentDir, f));
    out.push(msg);
  }
  return out;
}
