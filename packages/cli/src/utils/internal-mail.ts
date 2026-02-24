import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";

export interface InternalMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read: boolean;
}

function assertOfficeDir(officeDir: string): void {
  const resolved = resolve(officeDir);
  const root = resolve(join(process.env.HOME || homedir(), ".tps", "branch-office"));
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error(`Office directory out of bounds: ${officeDir}`);
  }
}

export function internalMailRoot(officeDir: string): string {
  assertOfficeDir(officeDir);
  const dir = join(officeDir, "mail", "internal");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getInternalInbox(officeDir: string, agent: string): { root: string; tmp: string; fresh: string; cur: string } {
  assertOfficeDir(officeDir);
  const safe = sanitizeIdentifier(agent);
  if (!agent || safe !== agent) throw new Error(`Invalid agent id: ${agent}`);
  const root = join(internalMailRoot(officeDir), agent);
  const tmp = join(root, "tmp");
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  mkdirSync(cur, { recursive: true });
  return { root, tmp, fresh, cur };
}

const MAX_BODY_BYTES = 64 * 1024;

export function sendInternalMessage(officeDir: string, from: string, to: string, body: string): InternalMessage {
  assertOfficeDir(officeDir);
  const safeFrom = sanitizeIdentifier(from);
  const safeTo = sanitizeIdentifier(to);
  if (!from || safeFrom !== from) throw new Error(`Invalid agent id: ${from}`);
  if (!to || safeTo !== to) throw new Error(`Invalid agent id: ${to}`);
  if (body.includes("\u0000")) throw new Error("Message body contains invalid null byte.");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("Message body exceeds maximum size (64KB).");

  const inbox = getInternalInbox(officeDir, to);
  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const message: InternalMessage = { id, from, to, body, timestamp, read: false };

  const safeTs = timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  writeFileSync(join(inbox.tmp, filename), JSON.stringify(message, null, 2), "utf-8");
  renameSync(join(inbox.tmp, filename), join(inbox.fresh, filename));

  return message;
}

export function checkInternalMessages(officeDir: string, agent: string): InternalMessage[] {
  assertOfficeDir(officeDir);
  const safe = sanitizeIdentifier(agent);
  if (!agent || safe !== agent) throw new Error(`Invalid agent id: ${agent}`);
  const inbox = getInternalInbox(officeDir, agent);
  const files = readdirSync(inbox.fresh).filter((f) => f.endsWith(".json"));
  const messages: InternalMessage[] = [];

  for (const f of files) {
    const fromPath = join(inbox.fresh, f);
    const toPath = join(inbox.cur, f);
    renameSync(fromPath, toPath);
    const raw = readFileSync(toPath, "utf-8");
    const msg = JSON.parse(raw) as InternalMessage;
    msg.read = true;
    messages.push(msg);
  }

  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

