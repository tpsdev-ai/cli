/**
 * Flair context provider for the agent package.
 *
 * Provides Flair-backed system prompt bootstrapping and memory writes.
 * Uses the same TPS-Ed25519 signing scheme as the CLI FlairClient.
 */

import crypto from "node:crypto";
import { parseFlairPublicKey } from "../lib/public-key.js";
import { readPrivateKeyAtPath } from "../lib/agent-keys.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlairConfig } from "../runtime/types.js";

export interface FlairAgent {
  id: string;
  name: string;
  publicKey: string;
}

export interface FlairMemory {
  id: string;
  agentId: string;
  content: string;
  type?: string;
  score?: number;
}

export interface FlairSoulEntry {
  key: string;
  value: string;
}

class FlairHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class FlairContextProvider {
  private readonly url: string;
  private readonly agentId: string;
  private readonly keyPath: string;

  constructor(agentId: string, config: FlairConfig = {}) {
    this.url = (config.url ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926").replace(/\/$/, "");
    this.agentId = agentId;
    this.keyPath =
      config.keyPath ??
      join(homedir(), ".tps", "identity", `${agentId}.key`);
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  private sign(method: string, path: string): string {
    const ts = Date.now().toString();
    const nonce = crypto.randomUUID();
    const payload = `${this.agentId}:${ts}:${nonce}:${method}:${path}`;

    const seed = readPrivateKeyAtPath(this.keyPath);
    if (!seed) {
      throw new Error(`Flair key not found at ${this.keyPath}. Run: tps agent create --id ${this.agentId}`);
    }
    const key = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8",
    });
    const sig = crypto.sign(null, Buffer.from(payload), key);
    return `TPS-Ed25519 ${this.agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.sign(method, path),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new FlairHttpError(`Flair ${method} ${path} → ${res.status}: ${txt}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/Health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Return null only for a not-found response; other failures throw. */
  async getAgent(name: string): Promise<FlairAgent | null> {
    try {
      const agent = await this.req<FlairAgent>("GET", `/Agent/${encodeURIComponent(name)}`);
      if (!agent || typeof agent.publicKey !== "string") throw new Error("invalid principal record");
      parseFlairPublicKey(agent.publicKey);
      return agent;
    } catch (err) {
      if (err instanceof FlairHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async getSoul(): Promise<FlairSoulEntry[]> {
    const entries = await this.req<Array<{ key: string; value: string }>>(
      "GET",
      `/Soul?agentId=${encodeURIComponent(this.agentId)}`,
    );
    return entries;
  }

  async searchMemories(query: string, limit = 5): Promise<FlairMemory[]> {
    return this.req<FlairMemory[]>(
      "GET",
      `/MemorySearch?agentId=${encodeURIComponent(this.agentId)}&q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  async listRecentMemories(days = 3): Promise<FlairMemory[]> {
    return this.req<FlairMemory[]>(
      "GET",
      `/Memory?agentId=${encodeURIComponent(this.agentId)}&limit=${days * 3}`,
    );
  }

  async writeMemory(id: string, content: string, type = "conversation"): Promise<void> {
    const existing = await this.req("GET", `/Memory/${id}`).catch(() => null);
    const payload = {
      id,
      agentId: this.agentId,
      content,
      type,
      durability: "standard",
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      await this.req("PUT", `/Memory/${id}`, payload);
    } else {
      await this.req("POST", "/Memory", { ...payload, createdAt: new Date().toISOString() });
    }
  }

  /**
   * Build a system prompt supplement from Flair — soul + recent context.
   * Returns empty string if Flair is offline (graceful degradation).
   */
  async buildContextBlock(query?: string): Promise<string> {
    if (!(await this.ping())) return "";

    const parts: string[] = [];

    // Soul entries → identity block
    try {
      const soul = await this.getSoul();
      if (soul.length > 0) {
        parts.push("## Agent Identity (from Flair)");
        for (const entry of soul) {
          parts.push(`${entry.key}: ${entry.value}`);
        }
      }
    } catch {
      // non-fatal
    }

    // Semantic search if query provided
    if (query) {
      try {
        const results = await this.searchMemories(query, 5);
        if (results.length > 0) {
          parts.push("\n## Relevant Memory");
          for (const r of results) {
            const score = r.score ? ` [${r.score.toFixed(3)}]` : "";
            parts.push(`${score} ${r.id}: ${r.content.slice(0, 500)}`);
          }
        }
      } catch {
        // non-fatal
      }
    }

    return parts.join("\n");
  }
}
