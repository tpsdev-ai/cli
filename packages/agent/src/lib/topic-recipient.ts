import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function isTopicRecipient(address: unknown, agentId: string, from: string): boolean {
  if (typeof address !== "string" || !address.startsWith("topic:")) return false;
  const topic = address.slice("topic:".length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic) || topic.length > 64) return false;
  try {
    const root = process.env.TPS_HOME || join(process.env.HOME || homedir(), ".tps");
    const meta = JSON.parse(readFileSync(join(root, "topics", topic, "meta.json"), "utf8"));
    return Array.isArray(meta.subscribers) && meta.subscribers.includes(agentId)
      && (meta.allowedPublishers === undefined || (Array.isArray(meta.allowedPublishers)
        && (meta.allowedPublishers.length === 0 || meta.allowedPublishers.includes(from))));
  } catch {
    return false;
  }
}
