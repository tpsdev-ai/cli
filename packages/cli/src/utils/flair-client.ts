/**
 * Flair TypeScript client — Ed25519-authenticated requests to the Flair API.
 *
 * Auth protocol: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signatureBase64>
 * Signature payload: agentId:timestamp:nonce:METHOD:/path?query
 */
import { sign as ed25519Sign, createPrivateKey, randomUUID } from "node:crypto";
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
  durability?: "permanent" | "persistent" | "standard" | "ephemeral";
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  promotionStatus?: "pending" | "approved" | "rejected" | null;
  promotedAt?: string;
  promotedBy?: string;
  archived?: boolean;
  archivedAt?: string;
  archivedBy?: string;
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
  _score: number;
  type?: string;
}


export interface ReflectResult {
  memories: Memory[];
  prompt: string;
  suggestedTags: string[];
  count: number;
}

export interface ConsolidateCandidate {
  memory: Memory;
  suggestion: "promote" | "archive" | "keep";
  reason: string;
}

export interface ConsolidateResult {
  candidates: ConsolidateCandidate[];
  prompt: string;
}

export interface WorkspaceStateRecord {
  id: string;
  agentId: string;
  ref: string;
  label?: string;
  provider: string;
  timestamp: string;
  metadata?: string;       // JSON blob
  taskId?: string;
  phase?: string;          // "pre-task" | "post-task" | "failure" | "boot"
  summary?: string;
  filesChanged?: string[];
  createdAt: string;
}

export interface OrgEvent {
  id: string;
  authorId: string;
  kind: string;
  scope?: string;
  summary: string;
  detail?: string;
  targetIds?: string[];
  refId?: string;
  createdAt: string;
  expiresAt?: string;
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
  private _privateKey: ReturnType<typeof createPrivateKey> | null = null;

  constructor(config: FlairConfig) {
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:9926").replace(/\/$/, "");
    this.agentId = config.agentId;
    this.keyPath =
      config.keyPath ??
      join(homedir(), ".tps", "identity", `${config.agentId}.key`);
  }

  private loadKey(): ReturnType<typeof createPrivateKey> {
    if (this._privateKey) return this._privateKey;
    let raw: string;
    try {
      raw = readFileSync(this.keyPath, "utf-8").trim();
    } catch {
      throw new Error(
        `Cannot read Flair private key at ${this.keyPath}. ` +
          `Run 'tps agent create --id ${this.agentId}' first.`,
      );
    }
    // Support PEM, raw 32-byte binary seed, and base64 DER/PKCS8
    const rawBuf = readFileSync(this.keyPath);
    if (raw.startsWith("-----")) {
      this._privateKey = createPrivateKey(raw);
    } else if (rawBuf.length === 32) {
      // Raw Ed25519 seed — wrap in PKCS8 envelope
      const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
      this._privateKey = createPrivateKey({
        key: Buffer.concat([pkcs8Header, rawBuf]),
        format: "der",
        type: "pkcs8",
      });
    } else {
      this._privateKey = createPrivateKey({
        key: Buffer.from(raw, "base64"),
        format: "der",
        type: "pkcs8",
      });
    }
    return this._privateKey;
  }

  private sign(method: string, path: string): string {
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const payload = `${this.agentId}:${ts}:${nonce}:${method}:${path}`;
    const key = this.loadKey();
    const sig = ed25519Sign(null, Buffer.from(payload), key);
    return `TPS-Ed25519 ${this.agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeader = this.sign(method, path);
    const headers: Record<string, string> = { Authorization: authHeader };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Flair ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /**
   * Register agent in Flair. Uses admin Basic auth because the agent's
   * public key isn't in the DB yet (chicken-and-egg: can't verify a
   * signature for an agent that doesn't exist).
   */
  async registerAgent(
    name: string,
    publicKey: string,
    adminAuth?: string,
  ): Promise<FlairAgent> {
    const url = `${this.baseUrl}/Agent/${this.agentId}`;
    const auth = adminAuth ?? process.env.FLAIR_ADMIN_AUTH ?? "admin:admin123";
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(auth).toString("base64")}`,
      },
      body: JSON.stringify({
        id: this.agentId,
        name,
        publicKey,
        createdAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Flair agent registration failed: ${res.status}: ${text}`);
    }
    if (res.status === 204) return { id: this.agentId, name, publicKey } as FlairAgent;
    return res.json() as Promise<FlairAgent>;
  }

  async getAgent(id?: string): Promise<FlairAgent | null> {
    try {
      return await this.request<FlairAgent>("GET", `/Agent/${id ?? this.agentId}`);
    } catch {
      return null;
    }
  }

  async listMemories(limit = 50): Promise<Memory[]> {
    return this.request<Memory[]>(
      "GET",
      `/Memory/?agentId=${encodeURIComponent(this.agentId)}`,
    );
  }

  async writeMemory(
    id: string,
    content: string,
    opts: {
      durability?: "permanent" | "persistent" | "standard" | "ephemeral";
      type?: string;
      tags?: string[];
    } = {},
  ): Promise<void> {
    await this.request("PUT", `/Memory/${id}`, {
      id,
      agentId: this.agentId,
      content,
      durability: opts.durability ?? "standard",
      type: opts.type ?? "daily",
      tags: opts.tags,
      createdAt: new Date().toISOString(),
    });
  }

  async getMemory(id: string): Promise<Memory> {
    return this.request<Memory>("GET", `/Memory/${id}`);
  }

  async getSoul(): Promise<SoulEntry[]> {
    return this.request<SoulEntry[]>(
      "GET",
      `/Soul/?agentId=${encodeURIComponent(this.agentId)}`,
    );
  }

  async setSoul(key: string, value: string): Promise<void> {
    const id = `${this.agentId}-${key}`;
    await this.request("PUT", `/Soul/${id}`, {
      id,
      agentId: this.agentId,
      key,
      value,
      durability: "permanent",
      createdAt: new Date().toISOString(),
    });
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const result = await this.request<{ results: SearchResult[] }>(
      "POST",
      "/SearchMemories/",
      { agentId: this.agentId, q: query, limit },
    );
    return result.results ?? [];
  }

  async bootstrap(opts: { days?: number; query?: string } = {}): Promise<string> {
    const days = opts.days ?? 3;
    const sections: string[] = [];
    try {
      const soul = await this.getSoul();
      if (soul.length > 0) {
        sections.push("## Identity\n");
        for (const entry of soul)
          sections.push(`**${entry.key}:** ${entry.value}\n`);
      }
    } catch {}
    try {
      const memories = await this.listMemories(50);
      if (memories.length > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const recent = memories
          .filter((m) => new Date(m.createdAt ?? "") >= cutoff)
          .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        if (recent.length > 0) {
          sections.push(`\n## Recent Memory (last ${days} days)\n`);
          for (const m of recent)
            sections.push(
              `### ${m.createdAt?.slice(0, 10)} — ${m.id}\n${m.content.slice(0, 2000)}\n`,
            );
        }
      }
    } catch {}
    if (opts.query) {
      try {
        const results = await this.search(opts.query, 5);
        if (results.length > 0) {
          sections.push(
            `\n## Relevant Context (query: "${opts.query}")\n`,
          );
          for (const r of results)
            sections.push(
              `[${r._score.toFixed(3)}] ${r.id}: ${r.content.slice(0, 500)}\n`,
            );
        }
      } catch {}
    }
    return sections.join("") || "(No Flair context available)";
  }

  // ─── Memory governance (admin-only on Flair server) ──────────────────────────

  async listMemoriesFull(opts: {
    agentId?: string;
    durability?: string;
    promotionStatus?: string;
    archived?: boolean;
    limit?: number;
  } = {}): Promise<Memory[]> {
    const agentId = opts.agentId ?? this.agentId;
    const params = new URLSearchParams({ agentId, limit: String(opts.limit ?? 50) });
    if (opts.durability) params.set("durability", opts.durability);
    return this.request<Memory[]>("GET", `/Memory/?${params.toString()}`);
  }


  /** Read-modify-write: GET existing record, merge patch, PUT back. Prevents field loss on partial updates. */
  private async patchRecord(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const existing = await this.request<Record<string, unknown>>("GET", `/${table}/${encodeURIComponent(id)}`).catch(() => null);
    const merged = { ...(existing ?? {}), ...patch, id };  // id always present
    await this.request("PUT", `/${table}/${encodeURIComponent(id)}`, merged);
  }

  async approveMemory(id: string): Promise<void> {
    await this.patchRecord("Memory", id, {
      promotionStatus: "approved",
      promotedBy: this.agentId,
      promotedAt: new Date().toISOString(),
      durability: "permanent",
    });
  }

  async rejectMemory(id: string): Promise<void> {
    await this.patchRecord("Memory", id, {
      promotionStatus: "rejected",
    });
  }

  async archiveMemory(id: string): Promise<void> {
    await this.patchRecord("Memory", id, {
      archived: true,
      archivedBy: this.agentId,
      archivedAt: new Date().toISOString(),
    });
  }

  async unarchiveMemory(id: string): Promise<void> {
    await this.patchRecord("Memory", id, {
      archived: false,
      archivedBy: null,
      archivedAt: null,
    });
  }

  async purgeMemory(id: string): Promise<void> {
    await this.request("DELETE", `/Memory/${id}`);
  }

  async proposeMemory(id: string, content: string, tags?: string[]): Promise<void> {
    await this.request("PUT", `/Memory/${id}`, {
      id,
      agentId: this.agentId,
      content,
      durability: "standard",
      promotionStatus: "pending",
      promotedBy: this.agentId,
      tags,
      createdAt: new Date().toISOString(),
    });
  }

  // ─── Soul governance ───────────────────────────────────────────────────────

  async getSoulFor(agentId: string): Promise<SoulEntry[]> {
    return this.request<SoulEntry[]>("GET", `/Soul/?agentId=${encodeURIComponent(agentId)}`);
  }

  async setSoulEntry(agentId: string, key: string, value: string): Promise<void> {
    const id = `${agentId}-${key}`;
    await this.request("PUT", `/Soul/${id}`, {
      id,
      agentId,
      key,
      value,
      durability: "permanent",
      createdAt: new Date().toISOString(),
    });
  }

  async deleteSoulEntry(agentId: string, key: string): Promise<void> {
    const id = `${agentId}-${key}`;
    await this.request("DELETE", `/Soul/${id}`);
  }



  async updateAgent(agentId: string, patch: Partial<FlairAgent>): Promise<void> {
    const existing = await this.getAgent(agentId);
    if (!existing) throw new Error(`Agent ${agentId} not found`);
    await this.request("PUT", `/Agent/${agentId}`, { ...existing, ...patch });
  }

  async seedAgent(opts: {
    agentId: string;
    displayName?: string;
    role?: "admin" | "agent";
    soulTemplate?: Record<string, string>;
    starterMemories?: Array<{ content: string; tags?: string[]; durability?: string }>;
  }): Promise<{ agent: FlairAgent; soulEntries: any[]; memories: any[] }> {
    return this.request("POST", "/AgentSeed/", opts);
  }

  async reflectMemory(opts: {
    agentId?: string;
    scope?: "recent" | "tagged" | "all";
    since?: string;
    maxMemories?: number;
    focus?: "lessons_learned" | "patterns" | "decisions" | "errors";
    tag?: string;
  } = {}): Promise<ReflectResult> {
    return this.request<ReflectResult>("POST", "/ReflectMemories/", {
      agentId: opts.agentId ?? this.agentId,
      scope: opts.scope ?? "recent",
      since: opts.since,
      maxMemories: opts.maxMemories ?? 50,
      focus: opts.focus ?? "lessons_learned",
      tag: opts.tag,
    });
  }

  async consolidateMemory(opts: {
    agentId?: string;
    scope?: "persistent" | "standard" | "all";
    olderThan?: string;
    limit?: number;
  } = {}): Promise<ConsolidateResult> {
    return this.request<ConsolidateResult>("POST", "/ConsolidateMemories/", {
      agentId: opts.agentId ?? this.agentId,
      scope: opts.scope ?? "persistent",
      olderThan: opts.olderThan ?? "30d",
      limit: opts.limit ?? 20,
    });
  }

  // ─── Org events ─────────────────────────────────────────────────────────

  async publishEvent(event: {
    kind: string;
    scope?: string;
    summary: string;
    detail?: string;
    targetIds?: string[];
    refId?: string;
    expiresAt?: string;
  }): Promise<void> {
    const id = `${this.agentId}-${Date.now()}`;
    await this.request("POST", "/OrgEvent/", {
      id,
      authorId: this.agentId,
      ...event,
      createdAt: new Date().toISOString(),
    });
  }

  async getEventsSince(participantId: string, since: Date): Promise<OrgEvent[]> {
    try {
      return await this.request<OrgEvent[]>(
        "GET",
        `/OrgEventCatchup/${encodeURIComponent(participantId)}?since=${encodeURIComponent(since.toISOString())}`,
      );
    } catch {
      return [];
    }
  }

  // ─── Workspace state (OPS-47 Phase 2) ────────────────────────────────────

  async writeWorkspaceState(state: WorkspaceStateRecord): Promise<void> {
    await this.request("PUT", `/WorkspaceState/${encodeURIComponent(state.id)}`, state);
  }

  async getLatestWorkspaceState(agentId: string): Promise<WorkspaceStateRecord | null> {
    try {
      return await this.request<WorkspaceStateRecord>("GET", `/WorkspaceLatest/${encodeURIComponent(agentId)}`);
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/Health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function createFlairClient(
  agentId: string,
  baseUrl?: string,
  keyPath?: string,
): FlairClient {
  return new FlairClient({
    agentId,
    baseUrl: baseUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926",
    keyPath,
  });
}
