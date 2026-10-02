import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isTopicRecipient, verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { assertValidBody, sendMessage } from "./mail.js";
import { signOutboundBody } from "./mail-sign.js";
import { createMailVerifyClient, type MailVerifyConfig } from "./mail-verify.js";
export { isTopicRecipient } from "@tpsdev-ai/agent";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:mail");


// ── Types ──────────────────────────────────────────────────────────────────

export interface TopicMeta {
  name: string;
  description: string;
  createdAt: string;
  subscribers: string[];
  allowedPublishers?: string[];  // undefined = open to all
}

export interface TopicLogEntry {
  id: string;
  topic: string;
  from: string;
  body: string;
  timestamp: string;
  envelope?: string;
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

// Atomic write: write to .tmp then renameSync — safe for concurrent readers/writers on same filesystem.
export function writeMeta(topic: string, meta: TopicMeta): void {
  const p = metaPath(topic);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
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
  const log = readLog(topic);
  if (cursor.startsWith("@")) {
    const index = log.findIndex((entry) => entry.id === cursor.slice(1));
    // A missing cursor must replay; delivered tracking makes that safe.
    return index < 0 ? log : log.slice(index + 1);
  }
  return log.filter((e) => e.timestamp > cursor);
}

// ── Public API ─────────────────────────────────────────────────────────────

export function createTopic(name: string, description?: string, allowedPublishers?: string[]): TopicMeta {
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
    ...(allowedPublishers ? { allowedPublishers } : {}),
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

  if (meta.allowedPublishers && meta.allowedPublishers.length > 0 && !meta.allowedPublishers.includes(from)) {
    throw new Error(`Agent '${from}' is not authorized to publish to topic '${topic}'`);
  }

  const recipients = meta.subscribers.filter((subscriberId) => subscriberId !== from);
  const signed = signOutboundBody(from, `topic:${topic}`, body, {
    requireKey: true, rationale: `agent ${from} topic publish`,
  });
  const envelope = JSON.parse(signed) as Envelope;

  // 1. Append to topic log
  const entry: TopicLogEntry = {
    id: envelope.messageId,
    topic,
    from,
    body,
    timestamp: envelope.timestamp,
    envelope: signed,
  };
  appendFileSync(logPath(topic), JSON.stringify(entry) + "\n", "utf-8");

  // 2. Fan-out to all subscribers
  for (const subscriberId of recipients) {
    try {
      const msg = sendMessage(subscriberId, signed, from);
      // Patch topic fields into the written file
      if (existsSync(msg.filePath)) {
        const existing = JSON.parse(readFileSync(msg.filePath, "utf-8"));
        existing.topic = topic;
        existing.topicMessageId = entry.id;
        writeFileSync(msg.filePath, JSON.stringify(existing, null, 2), "utf-8");
      }
      markDelivered(subscriberId, entry.id);
    } catch (err: any) {
      // Log but don't fail the publish if one subscriber's inbox is full
      serror(`Warning: failed to deliver to ${subscriberId}: ${err.message}`);
    }
  }

  return entry;
}

export async function catchUpTopics(agentId: string, topics?: string[], config: MailVerifyConfig = {}): Promise<number> {
  assertValidAgentId(agentId);
  const cursors = readCursors(agentId);
  const subscriptions = topics ?? getSubscriptions(agentId);
  let delivered = 0;

  for (const topic of subscriptions) {
    const cursor = cursors[topic] ?? "1970-01-01T00:00:00Z";
    const missed = readLogSince(topic, cursor);

    for (const entry of missed) {
      if (typeof entry.envelope !== "string") {
        swarn(`topic-catch-up-unsigned-entry: skipping ${topic}/${entry.id}`);
        updateCursor(agentId, topic, `@${entry.id}`);
        continue;
      }
      let envelope: Envelope;
      try {
        envelope = JSON.parse(entry.envelope);
        if (!envelope || envelope.from !== entry.from || envelope.body !== entry.body
          || envelope.to !== `topic:${topic}` || entry.topic !== topic
          || envelope.messageId !== entry.id || envelope.timestamp !== entry.timestamp
          || typeof envelope.body !== "string" || typeof envelope.from !== "string"
          || !Array.isArray(envelope.delegationChain) || typeof envelope.signature !== "string"
          || !envelope.delegationChain.every((hop) => hop && typeof hop.agent === "string"
            && (hop.kind === "agent" || hop.kind === "human")
            && (hop.signature === null || typeof hop.signature === "string"))) {
          throw new Error("topic log/envelope mismatch");
        }
      } catch {
        swarn(`topic-catch-up-invalid-envelope: skipping ${topic}/${entry.id}`);
        updateCursor(agentId, topic, `@${entry.id}`);
        continue;
      }
      try {
        const verified = await verifyEnvelope(envelope, await createMailVerifyClient(agentId, config));
        if (!verified.ok) {
          const reason = /^agent (.+) not found in Flair$/.test(verified.reason)
            ? "unresolvable-principal" : "invalid-envelope";
          swarn(`topic-catch-up-${reason}: skipping ${topic}/${entry.id}`);
          updateCursor(agentId, topic, `@${entry.id}`);
          continue;
        }
      } catch {
        swarn(`topic-catch-up-verification-unavailable: retry ${topic}/${entry.id}`);
        return delivered;
      }
      if (!isTopicRecipient(envelope.to, agentId, envelope.from)) {
        swarn(`topic-catch-up-recipient-policy-unavailable: retry ${topic}/${entry.id}`);
        return delivered;
      }
      if (envelope.from === agentId) {
        updateCursor(agentId, topic, `@${entry.id}`);
        continue;
      }
      if (!alreadyDelivered(agentId, entry.id)) {
        try {
          const msg = sendMessage(agentId, entry.envelope, envelope.from);
          if (existsSync(msg.filePath)) {
            const existing = JSON.parse(readFileSync(msg.filePath, "utf-8"));
            existing.topic = topic;
            existing.topicMessageId = entry.id;
            writeFileSync(msg.filePath, JSON.stringify(existing, null, 2), "utf-8");
          }
          markDelivered(agentId, entry.id);
          delivered++;
        } catch (err: any) {
          serror(`Warning: catch-up delivery failed for ${topic}/${entry.id}: ${err.message}`);
          break; // Leave the cursor before this undelivered entry.
        }
      }
      // An already-delivered entry can be skipped without losing it.
      updateCursor(agentId, topic, `@${entry.id}`);
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
