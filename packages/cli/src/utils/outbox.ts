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

export function queueOutboxMessage(to: string, body: string, from: string, deliveryId?: string): "duplicate in progress" | void {
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
  const write = (): void => {
    const id = deliveryId ?? randomUUID();
    const timestamp = new Date().toISOString();
    const filename = deliveryId ? `github-${deliveryId}.json` : `${timestamp.replace(/[:.]/g, "-")}-${id}.json`;
    if (deliveryId && (existsSync(join(dir, filename)) || existsSync(join(outboxDir("sent"), filename)))) return;
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
  for (const filename of readdirSync(newDir).filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
    const path = join(newDir, filename);
    const record = JSON.parse(readFileSync(path, "utf-8")) as OutboxMessage;
    if (record.id === id) renameSync(path, join(sentDir, filename));
  }
}
