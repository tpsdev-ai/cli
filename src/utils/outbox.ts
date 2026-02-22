import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, filename), JSON.stringify({ id, to, from, body, timestamp }, null, 2), "utf-8");
}

export function drainOutbox(): OutboxMessage[] {
  const newDir = outboxDir("new");
  const sentDir = outboxDir("sent");
  mkdirSync(newDir, { recursive: true });
  mkdirSync(sentDir, { recursive: true });

  const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const src = join(newDir, f);
    const msg = JSON.parse(readFileSync(src, "utf-8")) as OutboxMessage;
    renameSync(src, join(sentDir, f));
    return msg;
  });
}
