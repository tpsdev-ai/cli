import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

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

export function queueOutboxMessage(to: string, body: string, from: string): void {
  const dir = outboxDir("new");
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const filename = `${timestamp.replace(/[:.]/g, "-")}-${id}.json`;
  const content = JSON.stringify({ id, to, from, body, timestamp }, null, 2);
  // Atomic write: stage to a dot-prefixed tmp file in the same directory, then
  // rename into place. drainOutbox filters out dot-prefixed files so a reader
  // running concurrently never sees a half-written file. rename(2) within the
  // same filesystem is atomic on POSIX.
  const tmp = join(dir, `.${filename}.tmp`);
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, join(dir, filename));
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
