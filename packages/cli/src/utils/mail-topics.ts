import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { sendMessage, assertValidBody } from "./mail.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TopicMeta {
  name: string;
  description: string;
  createdAt: string;
  subscribers: string[];
}

export interface TopicLogEntry {
  id: string;
  topic: string;
  from: string;
  body: string;
  timestamp: string;
}

// ── Paths ──────────────────────────────────────────────────────────────────

function tpsDir(): string {
  return process.env.TPS_HOME || join(process.env.HOME || homedir(), ".tps");
}

function topicsDir(): string {
  return join(tpsDir(), "topics");
}

function topicDir(topic: string): string {
  return join(topicsDir(), topic);
}

function logPath(topic: string): string {
  return join(topicDir(topic), "log.jsonl");
}

function metaPath(topic: string): string {
  return join(topicDir(topic), "meta.json");
}

function agentDir(agentId: string): string {
  return join(tpsDir(), "agents", agentId);
}

function cursorsPath(agentId: string): string {
  return join(agentDir(agentId), "topic-cursors.json");
}

function deliveredPath(agentId: string): string {
  return join(agentDir(agentId), "delivered.jsonl");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function assertValidTopicName(name: string): void {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64) {
    throw new Error(`Invalid topic name: "${name}". Use lowercase alphanumeric with hyphens.`);
  }
}

function assertValidAgentId(id: string): void {
  const safe = sanitizeIdentifier(id);
  if (!id || safe !== id) {
    throw new Error(`Invalid agent id: ${id}`);
  }
}

// ── Meta ───────────────────────────────────────────────────────────────────

export function readMeta(topic: string): TopicMeta {
  const p = metaPath(topic);
  if (!existsSync(p)) {
    throw new Error(`Topic not found: ${topic}`);
  }
  return JSON.parse(readFileSync(p, "utf-8")) as TopicMeta;
}

export function writeMeta(topic: string, meta: TopicMeta): void {
  writeFileSync(metaPath(topic), JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

// ── Cursors ────────────────────────────────────────────────────────────────

function readCursors(agentId: string): Record<string, string> {
  const p = cursorsPath(agentId);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeCursors(agentId: string, cursors: Record<string, string>): void {
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cursorsPath(agentId), JSON.stringify(cursors, null, 2) + "\n", "utf-8");
}

export function updateCursor(agentId: string, topic: string, timestamp: string): void {
  const cursors = readCursors(agentId);
  cursors[topic] = timestamp;
  writeCursors(agentId, cursors);
}

// ── Delivered tracking (idempotency) ───────────────────────────────────────

function markDelivered(agentId: string, messageId: string): void {
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(deliveredPath(agentId), messageId + "\n", "utf-8");
}

function alreadyDelivered(agentId: string, messageId: string): boolean {
  const p = deliveredPath(agentId);
  if (!existsSync(p)) return false;
  const content = readFileSync(p, "utf-8");
  return content.includes(messageId);
}

// ── Log ────────────────────────────────────────────────────────────────────

function readLog(topic: string): TopicLogEntry[] {
  const p = logPath(topic);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TopicLogEntry);
}

function readLogSince(topic: string, cursor: string): TopicLogEntry[] {
  return readLog(topic).filter((e) => e.timestamp > cursor);
}

// ── Public API ─────────────────────────────────────────────────────────────

export function createTopic(name: string, description?: string): TopicMeta {
  assertValidTopicName(name);
  const dir = topicDir(name);
  if (existsSync(metaPath(name))) {
    throw new Error(`Topic already exists: ${name}`);
  }
  mkdirSync(dir, { recursive: true });

  const meta: TopicMeta = {
    name,
    description: description || "",
    createdAt: new Date().toISOString(),
    subscribers: [],
  };
  writeMeta(name, meta);
  writeFileSync(logPath(name), "", "utf-8");
  return meta;
}

export function listTopics(): Array<TopicMeta & { messageCount: number; lastMessage?: string }> {
  const dir = topicsDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "meta.json")))
    .map((d) => {
      const meta = readMeta(d);
      const log = readLog(d);
      return {
        ...meta,
        messageCount: log.length,
        lastMessage: log.length > 0 ? log[log.length - 1]!.timestamp : undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function subscribe(topic: string, agentId: string, fromBeginning = false): void {
  assertValidAgentId(agentId);
  const meta = readMeta(topic);

  if (meta.subscribers.includes(agentId)) {
    throw new Error(`${agentId} is already subscribed to ${topic}`);
  }

  meta.subscribers.push(agentId);
  writeMeta(topic, meta);

  // Set cursor: beginning of time for --from-beginning, otherwise now
  if (!fromBeginning) {
    updateCursor(agentId, topic, new Date().toISOString());
  }
}

export function unsubscribe(topic: string, agentId: string): void {
  assertValidAgentId(agentId);
  const meta = readMeta(topic);

  const idx = meta.subscribers.indexOf(agentId);
  if (idx === -1) {
    throw new Error(`${agentId} is not subscribed to ${topic}`);
  }

  meta.subscribers.splice(idx, 1);
  writeMeta(topic, meta);
}

export function publishToTopic(topic: string, from: string, body: string): TopicLogEntry {
  assertValidAgentId(from);
  assertValidBody(body);
  const meta = readMeta(topic);

  // 1. Append to topic log
  const entry: TopicLogEntry = {
    id: randomUUID(),
    topic,
    from,
    body,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(logPath(topic), JSON.stringify(entry) + "\n", "utf-8");

  // 2. Fan-out to all subscribers
  for (const subscriberId of meta.subscribers) {
    // Skip sending to the publisher themselves
    if (subscriberId === from) continue;
    try {
      const msg = sendMessage(subscriberId, body, from);
      // Patch topic fields into the written file
      const inbox = join(
        process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail"),
        subscriberId,
      );
      const safeTs = msg.timestamp.replace(/[:.]/g, "-");
      const filename = `${safeTs}-${msg.id}.json`;
      const filePath = join(inbox, "new", filename);
      if (existsSync(filePath)) {
        const existing = JSON.parse(readFileSync(filePath, "utf-8"));
        existing.topic = topic;
        existing.topicMessageId = entry.id;
        writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
      }
      markDelivered(subscriberId, entry.id);
    } catch (err: any) {
      // Log but don't fail the publish if one subscriber's inbox is full
      console.error(`Warning: failed to deliver to ${subscriberId}: ${err.message}`);
    }
  }

  return entry;
}

export function catchUpTopics(agentId: string, topics?: string[]): number {
  assertValidAgentId(agentId);
  const cursors = readCursors(agentId);
  const subscriptions = topics ?? getSubscriptions(agentId);
  let delivered = 0;

  for (const topic of subscriptions) {
    const cursor = cursors[topic] ?? "1970-01-01T00:00:00Z";
    const missed = readLogSince(topic, cursor);

    for (const entry of missed) {
      if (entry.from === agentId) continue;
      if (!alreadyDelivered(agentId, entry.id)) {
        try {
          const msg = sendMessage(agentId, entry.body, entry.from);
          const inbox = join(
            process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail"),
            agentId,
          );
          const safeTs = msg.timestamp.replace(/[:.]/g, "-");
          const filename = `${safeTs}-${msg.id}.json`;
          const filePath = join(inbox, "new", filename);
          if (existsSync(filePath)) {
            const existing = JSON.parse(readFileSync(filePath, "utf-8"));
            existing.topic = topic;
            existing.topicMessageId = entry.id;
            writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
          }
          markDelivered(agentId, entry.id);
          delivered++;
        } catch (err: any) {
          console.error(`Warning: catch-up delivery failed for ${topic}/${entry.id}: ${err.message}`);
        }
      }
    }

    // Advance cursor
    if (missed.length > 0) {
      updateCursor(agentId, topic, missed[missed.length - 1]!.timestamp);
    }
  }

  return delivered;
}

function getSubscriptions(agentId: string): string[] {
  // Read subscriptions from all topics that include this agent
  const dir = topicsDir();
  if (!existsSync(dir)) return [];
  const subs: string[] = [];
  for (const d of readdirSync(dir)) {
    try {
      const meta = readMeta(d);
      if (meta.subscribers.includes(agentId)) {
        subs.push(d);
      }
    } catch { /* skip invalid */ }
  }
  return subs;
}
