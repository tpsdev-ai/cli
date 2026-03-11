import type { FlairClient } from "../utils/flair-client.js";
import { randomUUID } from "node:crypto";
import type { MemoryProvider, MemoryResult, MemoryWriteInput, MemoryRecord } from "./registry.js";

export class FlairMemoryProvider implements MemoryProvider {
  constructor(private client: FlairClient) {}

  async search(query: string, limit = 5): Promise<MemoryResult[]> {
    const results = await this.client.search(query, limit);
    return results.map((r) => ({
      id: r.id,
      text: r.content,
      agentId: r.agentId,
      similarity: r._score,
      createdAt: undefined,
    }));
  }

  async write(content: MemoryWriteInput): Promise<{ id: string }> {
    const id = content.supersedes ?? `${content.agentId}-${randomUUID()}`;
    await this.client.writeMemory(id, content.text, {
      durability: content.durability,
      type: content.type,
      tags: content.tags,
    });
    return { id };
  }

  async read(id: string): Promise<MemoryRecord | null> {
    const record = await this.client.getMemory(id);
    if (!record) return null;
    return {
      id: record.id,
      text: record.content,
      agentId: record.agentId,
      durability: record.durability,
      tags: record.tags,
      createdAt: record.createdAt,
      type: record.type,
      archived: record.archived,
      updatedAt: record.updatedAt,
    };
  }

  async bootstrap(opts?: { query?: string; maxTokens?: number }): Promise<string> {
    void opts;
    return this.client.bootstrap();
  }

  async ping(): Promise<boolean> {
    return this.client.ping();
  }
}
