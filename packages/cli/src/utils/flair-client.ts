/**
 * Flair TypeScript client — Ed25519-authenticated requests to the Flair API.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FlairConfig {
  baseUrl?: string;
  agentId: string;
  keyPath?: string;
}

export interface Memory {
  id: string;
  agentId: string;
  content: string;
  type?: string;
  durability?: "permanent" | "standard";
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SoulEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
}

export interface SearchResult {
  id: string;
  agentId: string;
  content: string;
  score: number;
  type?: string;
}

export interface FlairAgent {
  id: string;
  name: string;
  publicKey: string;
  createdAt?: string;
}

export class FlairClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly keyPath: string;

  constructor(config: FlairConfig) {
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:9926").replace(/\/$/, "");
    this.agentId = config.agentId;
    this.keyPath =
      config.keyPath ??
      join(homedir(), ".tps", "identity", `${config.agentId}.key`);
  }

  private sign(method: string, path: string): string {
    const ts = Date.now().toString();
    const payload = `${this.agentId}:${ts}:${method}:${path}`;
    let privKeyPem: string;
    try {
      privKeyPem = readFileSync(this.keyPath, "utf-8");
    } catch {
      throw new Error(
        `Cannot read Flair private key at ${this.keyPath}. ` +
          `Run 'tps agent create --id ${this.agentId}' first.`,
      );
    }
    const sign = createSign("SHA256");
    sign.update(payload);
    sign.end();
    const sig = sign.sign({ key: privKeyPem, dsaEncoding: "der" }, "base64url");
    return `TPS-Ed25519 agentId=${this.agentId},ts=${ts},sig=${sig}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeader = this.sign(method, path);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Flair ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async registerAgent(name: string, publicKey: string): Promise<FlairAgent> {
    return this.request<FlairAgent>("POST", "/Agent", { id: this.agentId, name, publicKey });
  }

  async getAgent(id?: string): Promise<FlairAgent | null> {
    try { return await this.request<FlairAgent>("GET", `/Agent/${id ?? this.agentId}`); }
    catch { return null; }
  }

  async listMemories(limit = 10): Promise<Memory[]> {
    return this.request<Memory[]>("GET", `/Memory?agentId=${encodeURIComponent(this.agentId)}&limit=${limit}`);
  }

  async writeMemory(id: string, content: string, opts: { durability?: "permanent" | "standard"; type?: string; tags?: string[] } = {}): Promise<void> {
    const existing = await this.request("GET", `/Memory/${id}`).catch(() => null);
    const payload = { id, agentId: this.agentId, content, durability: opts.durability ?? "standard", type: opts.type ?? "daily", tags: opts.tags, updatedAt: new Date().toISOString() };
    if (existing) { await this.request("PUT", `/Memory/${id}`, payload); }
    else { await this.request("POST", "/Memory", { ...payload, createdAt: new Date().toISOString() }); }
  }

  async getMemory(id: string): Promise<Memory> {
    return this.request<Memory>("GET", `/Memory/${id}`);
  }

  async getSoul(): Promise<SoulEntry[]> {
    return this.request<SoulEntry[]>("GET", `/Soul?agentId=${encodeURIComponent(this.agentId)}`);
  }

  async setSoul(key: string, value: string): Promise<void> {
    const id = `${this.agentId}-${key}`;
    const existing = await this.request("GET", `/Soul/${id}`).catch(() => null);
    const payload = { id, agentId: this.agentId, key, value, updatedAt: new Date().toISOString() };
    if (existing) { await this.request("PUT", `/Soul/${id}`, payload); }
    else { await this.request("POST", "/Soul", { ...payload, createdAt: new Date().toISOString() }); }
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    return this.request<SearchResult[]>("GET", `/MemorySearch?agentId=${encodeURIComponent(this.agentId)}&q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  async bootstrap(opts: { days?: number; query?: string } = {}): Promise<string> {
    const days = opts.days ?? 3;
    const sections: string[] = [];
    try {
      const soul = await this.getSoul();
      if (soul.length > 0) {
        sections.push("## Identity\n");
        for (const entry of soul) sections.push(`**${entry.key}:** ${entry.value}\n`);
      }
    } catch {}
    try {
      const memories = await this.listMemories(days * 3);
      if (memories.length > 0) {
        sections.push("\n## Recent Memory\n");
        for (const m of memories.slice(0, days)) sections.push(`### ${m.id}\n${m.content.slice(0, 2000)}\n`);
      }
    } catch {}
    if (opts.query) {
      try {
        const results = await this.search(opts.query, 5);
        if (results.length > 0) {
          sections.push(`\n## Relevant Context (query: "${opts.query}")\n`);
          for (const r of results) sections.push(`[${r.score.toFixed(3)}] ${r.id}: ${r.content.slice(0, 500)}\n`);
        }
      } catch {}
    }
    return sections.join("") || "(No Flair context available)";
  }

  async ping(): Promise<boolean> {
    try { const res = await fetch(`${this.baseUrl}/Health`); return res.ok; }
    catch { return false; }
  }
}

export function createFlairClient(agentId: string, baseUrl?: string): FlairClient {
  return new FlairClient({ agentId, baseUrl: baseUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926" });
}
