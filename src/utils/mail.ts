import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { logEvent } from "./archive.js";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_INBOX_MESSAGES = 100;

function assertValidAgentId(agent: string): void {
  const safe = sanitizeIdentifier(agent);
  if (!agent || safe !== agent) {
    throw new Error(`Invalid agent id: ${agent}`);
  }
}

export function assertValidBody(body: string): void {
  if (body.includes("\u0000")) {
    throw new Error("Message body contains invalid null byte.");
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(`Message body exceeds maximum size (64KB). Got ${Math.ceil(bytes / 1024)}KB.`);
  }
}

export function getMailDir(): string {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getInbox(agent: string): { root: string; tmp: string; fresh: string; cur: string } {
  assertValidAgentId(agent);
  const root = join(getMailDir(), agent);
  const tmp = join(root, "tmp");
  const fresh = join(root, "new");
  const cur = join(root, "cur");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  mkdirSync(cur, { recursive: true });
  return { root, tmp, fresh, cur };
}

function readMessagesFromDir(dir: string, read: boolean): MailMessage[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf-8");
      const msg = JSON.parse(raw) as MailMessage;
      msg.read = read;
      return msg;
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function countInboxMessages(agent: string): number {
  const inbox = getInbox(agent);
  return readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")).length +
    readdirSync(inbox.cur).filter((f) => f.endsWith(".json")).length;
}

export function sendMessage(to: string, body: string, from?: string): MailMessage {
  assertValidAgentId(to);
  const sender = from || "unknown";
  assertValidAgentId(sender);
  assertValidBody(body);

  const inbox = getInbox(to);
  const quotaCount = countInboxMessages(to);
  if (quotaCount >= MAX_INBOX_MESSAGES) {
    throw new Error("Inbox full");
  }

  const timestamp = new Date().toISOString();
  const id = randomUUID();
  const message: MailMessage = {
    id,
    from: sender,
    to,
    body,
    timestamp,
    read: false,
  };

  const safeTs = timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  const tmpPath = join(inbox.tmp, filename);
  const newPath = join(inbox.fresh, filename);
  writeFileSync(tmpPath, JSON.stringify(message, null, 2), "utf-8");
  renameSync(tmpPath, newPath);

  logEvent({ event: "sent", from: sender, to, messageId: id }, body);

  return message;
}

export function checkMessages(agent: string): MailMessage[] {
  assertValidAgentId(agent);
  const inbox = getInbox(agent);
  const files = readdirSync(inbox.fresh).filter((f) => f.endsWith(".json"));
  const messages: MailMessage[] = [];

  for (const f of files) {
    const from = join(inbox.fresh, f);
    const to = join(inbox.cur, f);
    renameSync(from, to);
    const raw = readFileSync(to, "utf-8");
    const msg = JSON.parse(raw) as MailMessage;
    msg.read = true;
    messages.push(msg);
    logEvent({ event: "read", from: msg.from, to: agent, messageId: msg.id }, msg.body);
  }

  return messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

export function listMessages(agent: string): MailMessage[] {
  assertValidAgentId(agent);
  const inbox = getInbox(agent);
  const unread = readMessagesFromDir(inbox.fresh, false);
  const read = readMessagesFromDir(inbox.cur, true);
  return [...unread, ...read].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}
