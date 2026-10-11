/**
 * Flair TypeScript client — Ed25519-authenticated requests to the Flair API.
 *
 * Auth protocol: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signatureBase64>
 * Signature payload: agentId:timestamp:nonce:METHOD:/path?query
 */
import { createPrivateKey, sign as ed25519Sign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FlairConfig {
  baseUrl?: string;
  agentId: string;
  keyPath: string;
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
  status?: string;
  lastHeartbeat?: string;
  createdAt?: string;
}

export interface SkillAssignment {
  id: string;
  agentId: string;
  key: "skill-assignment";
  value: string;
  priority?: "critical" | "high" | "standard" | "low";
  metadata?: string; // JSON: { source, version, hash, reviewedAt, reviewedBy, status }
  durability: "permanent";
  createdAt: string;
  updatedAt?: string;
}

export interface SkillScanViolation {
  type: string;
  line: number;
  content: string;
}

export interface SkillScanResult {
  safe: boolean;
  violations: SkillScanViolation[];
  riskLevel: "low" | "medium" | "high" | "critical";
}

/** The activity vocabulary Flair's Presence contract accepts. */
export type PresenceActivity = "coding" | "reviewing" | "planning" | "debugging" | "idle";

export class FlairRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "FlairRequestError";
  }
}

/**
 * A fixed list of error-code strings. When a response has an `error` field,
 * the client reads an allow-listed string from it; other values become
 * `unrecognized_error`. The list is not claimed complete;
 * no entry is claimed reachable from a particular route.
 *
 * Membership is a MODULE-PRIVATE Set; the list is exported as a FROZEN ARRAY,
 * for inspection only. A `ReadonlySet` is a type-only guarantee, and a live
 * exported Set is mutable at runtime — a consumer (or a probe) could add a code
 * and change how a non-OK response is formatted. With the set private and the
 * exported view frozen, neither an add nor a write can do so.
 *
 * A shape test (a regex for "a short lower-case token") is not a control: a
 * credential fragment — a slice of a base64 Basic credential, a nonce, a
 * signature component — can itself be regex-shaped, so a shape test would pass
 * it straight through. Naming only an enumerated constant bounds the damage:
 * arbitrary response text cannot enter a non-OK response error. An error from a
 * NON-OK HTTP RESPONSE contains the entry point, method, requested pathname,
 * status, and an allow-listed code selected from the response's `error` field
 * (else `unrecognized_error`); raw bodies, other response text and transport
 * messages are never included. (A fixed list cannot rule out a coincidence with
 * a listed code, but the client names a constant it already holds rather than
 * echoing response text.)
 *
 * Caught transport failures use `Flair <entry> <method> <pathname> transport
 * error: <reason>`. A failed successful-response JSON parse uses
 * `Flair <entry> <method> <pathname> → <status>: malformed response body`;
 * request() and registerAgent() accept 204 without parsing.
 * Local checks interpolate ids (promotion refusals, invalid principal records,
 * governance read refusals and missing agents); the private-key read failure
 * interpolates the key path and agent id. A governance read failure also embeds
 * the caught error's message. These local messages are outside the response bound.
 */
const FLAIR_ERROR_CODE_LIST: readonly string[] = [
  "invalid_authorization_header",
  "method_not_allowed",
  "timestamp_out_of_window",
  "nonce_replay_detected",
  "unknown_agent",
  "principal_deactivated",
  "invalid_signature",
  "signature_verification_failed",
  "ambiguous_memory_id",
  "replay_store_unavailable",
  "rate_limit_exceeded",
  "invalid_agent_id",
  "agent_lookup_failed",
  "skill_assignment_not_seedable",
  "invalid_durability",
  "invalid_visibility",
  "invalid_visibility_for_durability",
  "invalid_expiry",
  "content_safety_violation",
  "reembed_no_text",
  "reembed_row_changed",
  "embedding_unavailable",
  "reindex_admin_only",
  "reindex_row_not_found",
  "reindex_would_change_row",
  "host_source_persist_failed",
  "host_source_delete_failed",
  "memory_id_content_suffix",
  "supersedes_target_unreadable",
  "supersedes_target_missing",
  "stored_row_changed",
  "stored_row_read_failed",
  "id_target_mismatch",
  "stored_row_lookup_failed",
  "skill_durability",
  "skill_write_path",
  "skill_scan_rejected",
  "skill_source_not_durable",
  "skill_opt_out_not_boolean",
  "skill_lineage_tag_removed",
  "skill_state_requires_delete",
  "skill_self_supersede",
  "skill_predecessor_missing",
  "skill_target_changed",
  "skill_head_missing",
  "skill_predecessor_stale",
  "skill_target_stale",
  "soul_write_requires_one_record",
  "soul_delete_requires_one_record",
  "soul_subject_occupied",
  "instruction_version_head_mismatch",
  "instruction_version_append_failed",
  "instruction_version_busy",
  "instruction_version_lock_unavailable",
  "invalid_activity",
  "presence_write_failed",
  "rem_aborted",
  "distillation_failed",
  "workspace_state_query_failed",
  "no_workspace_state_found",
];

/**
 * The allow-list as a FROZEN ARRAY, for inspection only; the membership test
 * is the module-private set below. Freezing the view means a consumer cannot
 * add or remove a code and change how a non-OK response is formatted.
 */
export const FLAIR_ERROR_CODES: readonly string[] = Object.freeze(FLAIR_ERROR_CODE_LIST);

/** Membership — module-private, so the exported view cannot change formatting. */
const FLAIR_ERROR_CODE_SET: ReadonlySet<string> = new Set(FLAIR_ERROR_CODE_LIST);

/** The code an error carries when the server named a value not on the list. */
const UNRECOGNIZED_ERROR = "unrecognized_error";

/**
 * The path an error names: the `pathname` of the URL the request was actually
 * sent with — never a query and never a fragment. A query string can carry an
 * agent id, a `since` timestamp, a filter, and a fragment is not sent at all,
 * so an error's pathname omits query and fragment; a path parameter that was
 * percent-encoded (an agent id carrying a separator, say) stays encoded in the
 * name, exactly as on the wire. Deriving the name from the URL the transport
 * carried — not from the uncanonicalized string a caller supplied — keeps the
 * reported path equal to the path the request sent.
 */
function requestedPath(url: string): string {
  return new URL(url).pathname;
}

/**
 * The allow-listed string from a response's `error` field, or `unrecognized_error`.
 * The body itself is excluded from the non-OK response error message.
 * Only a code that is one of the module's own fixed strings is named; every
 * other value — including a regex-shaped credential fragment — is
 * `UNRECOGNIZED_ERROR`.
 */
function responseErrorCode(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return UNRECOGNIZED_ERROR;
  }
  const code = (parsed as { error?: unknown } | null)?.error;
  return typeof code === "string" && FLAIR_ERROR_CODE_SET.has(code) ? code : UNRECOGNIZED_ERROR;
}

/** A non-OK response error: entry, method, pathname, status and an allow-listed code (else `unrecognized_error`). */
function responseError(entry: string, method: string, path: string, status: number, body: string): string {
  const code = responseErrorCode(body);
  return `Flair ${entry} ${method} ${path} → ${status}: ${code}`;
}

/** The `code` of a thrown value, from the value or its `cause` (Node's fetch). */
function errorCode(err: unknown): string {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (candidate && typeof candidate === "object") {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return "";
}

/**
 * The reason class of a transport failure, derived from the error's `code`
 * (Node carries it on `cause`), never from its message — a message can quote
 * the request, including its credential. An unknown code is `network failure`.
 */
function transportReason(err: unknown): string {
  switch (errorCode(err)) {
    case "ECONNREFUSED":
    case "ConnectionRefused":
      return "connection refused";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
    case "ConnectionTimedOut":
      return "timeout";
    case "ECONNRESET":
    case "ConnectionClosed":
    case "UND_ERR_SOCKET":
      return "connection reset";
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "DNSResolutionFailed":
      return "dns failure";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS failure";
    default:
      return "network failure";
  }
}

/** A caught transport failure: entry, method, pathname and a fixed reason class, without an HTTP status. */
function transportError(entry: string, method: string, path: string, err: unknown): string {
  return `Flair ${entry} ${method} ${path} transport error: ${transportReason(err)}`;
}

/** A successful-response JSON parse failure; request() and registerAgent() skip parsing on 204. */
function parseError(entry: string, method: string, path: string, status: number): string {
  return `Flair ${entry} ${method} ${path} → ${status}: malformed response body`;
}

/**
 * Flair exposes no operation that promotes or rejects a Memory by id: the
 * promotion operation `POST /PromoteMemoryCandidate` acts on a `MemoryCandidate`
 * id. Refuse by name rather than send a write Flair rejects.
 */
function promotionUnsupported(action: "approve" | "reject", id: string): Error {
  return new Error(
    `tps memory ${action} is unavailable: Flair has no operation that sets a memory's promotion status by id. ` +
      `Promotion uses Flair's candidate workflow (POST /PromoteMemoryCandidate, on a MemoryCandidate id). ` +
      `${id} was not changed.`,
  );
}

export class FlairClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly keyPath: string;
  private _privateKey: ReturnType<typeof createPrivateKey> | null = null;

  constructor(config: FlairConfig) {
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:9926").replace(/\/$/, "");
    this.agentId = config.agentId;
    this.keyPath = config.keyPath;
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

  /**
   * Send a signed request. The client's wrapper methods encode their ids; request() sends the path its caller supplies — a caller that builds a path from an id
   * must encode it with `encodeURIComponent` itself, or the URL (and the pathname
   * an error names) will not carry the id as one segment.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // The name an error carries is the pathname of the URL actually requested — the
    // same string the transport sent — never the caller-supplied `path` verbatim and
    // never a query or fragment.
    const route = requestedPath(url);
    const authHeader = this.sign(method, path);
    const headers: Record<string, string> = { Authorization: authHeader };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new FlairRequestError(transportError("request", method, route, err), 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FlairRequestError(responseError("request", method, route, res.status, text), res.status);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new FlairRequestError(parseError("request", method, route, res.status), res.status);
    }
  }

  /**
   * POST /Presence — the agent's OWN presence heartbeat, signed with `this`
   * agent's Ed25519 key (Flair keys the record by the signature's agentId).
   * `activity` is optional. cli#444: the codex
   * runtime records liveness HERE, never by writing `Agent.status` (that field is
   * the principal's lifecycle state).
   */
  async presence(activity?: PresenceActivity): Promise<void> {
    await this.request("POST", "/Presence", activity !== undefined ? { activity } : {});
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
    // The agent id is a path parameter: encode it so the URL — and the path an
    // error names — carries it as one encoded segment. An id containing `#` or
    // `?` would otherwise be dropped as a fragment or read as a query, and the
    // error would name text the request never sent.
    const route = `/Agent/${encodeURIComponent(this.agentId)}`;
    const url = `${this.baseUrl}${route}`;
    const requestedRoute = requestedPath(url);
    const auth = adminAuth ?? process.env.FLAIR_ADMIN_AUTH ?? "admin:admin123";
    let res: Response;
    try {
      res = await fetch(url, {
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
    } catch (err) {
      throw new Error(transportError("registerAgent", "PUT", requestedRoute, err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(responseError("registerAgent", "PUT", requestedRoute, res.status, text));
    }
    if (res.status === 204) return { id: this.agentId, name, publicKey } as FlairAgent;
    try {
      return (await res.json()) as FlairAgent;
    } catch {
      throw new Error(parseError("registerAgent", "PUT", requestedRoute, res.status));
    }
  }

  async getAgent(id?: string): Promise<FlairAgent | null> {
    try {
      return await this.request<FlairAgent>("GET", `/Agent/${encodeURIComponent(id ?? this.agentId)}`);
    } catch {
      return null;
    }
  }

  async getAgentForVerification(id: string): Promise<FlairAgent | null> {
    try {
      const agent = await this.request<FlairAgent>("GET", `/Agent/${encodeURIComponent(id)}`);
      if (!agent || typeof agent.publicKey !== "string") {
        throw new Error(`Flair returned an invalid principal record for ${id}`);
      }
      return agent;
    } catch (err) {
      if (err instanceof FlairRequestError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Read the public key Flair actually stores for `agentId`, over the operator
   * (Basic admin) credential. cli#512: the read-back that decides whether a
   * registration happened must not use the key it is verifying — an agent
   * whose key is not registered yet cannot read its own row. A 404 is the only
   * "no such row"; every other non-OK response throws, so a failed read is
   * never read as "absent".
   */
  async readStoredPublicKey(
    agentId: string = this.agentId,
    adminAuth?: string,
  ): Promise<{ found: boolean; publicKey: string | null }> {
    const auth = adminAuth ?? process.env.FLAIR_ADMIN_AUTH ?? "admin:admin123";
    // The name an error carries is the pathname of this same URL — the string the
    // request is sent with — so an id that needs encoding (`agent/sub`) is named
    // `agent%2Fsub`, as on the wire, never decoded and never a query or fragment.
    const route = `/Agent/${encodeURIComponent(agentId)}`;
    const url = `${this.baseUrl}${route}`;
    const requestedRoute = requestedPath(url);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` },
      });
    } catch (err) {
      throw new FlairRequestError(transportError("readStoredPublicKey", "GET", requestedRoute, err), 0);
    }
    if (res.status === 404) return { found: false, publicKey: null };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FlairRequestError(
        responseError("readStoredPublicKey", "GET", requestedRoute, res.status, text),
        res.status,
      );
    }
    let record: FlairAgent | null;
    try {
      record = (await res.json()) as FlairAgent | null;
    } catch {
      throw new FlairRequestError(parseError("readStoredPublicKey", "GET", requestedRoute, res.status), res.status);
    }
    return { found: true, publicKey: typeof record?.publicKey === "string" ? record.publicKey : null };
  }

  async listAgents(): Promise<FlairAgent[]> {
    try {
      return await this.request<FlairAgent[]>("GET", "/Agent/");
    } catch {
      return [];
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
    await this.request("PUT", `/Memory/${encodeURIComponent(id)}`, {
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
    return this.request<Memory>("GET", `/Memory/${encodeURIComponent(id)}`);
  }

  async getSoul(): Promise<SoulEntry[]> {
    return this.request<SoulEntry[]>(
      "GET",
      `/Soul/?agentId=${encodeURIComponent(this.agentId)}`,
    );
  }

  async setSoul(key: string, value: string): Promise<void> {
    const id = `${this.agentId}-${key}`;
    await this.request("PUT", `/Soul/${encodeURIComponent(id)}`, {
      id,
      agentId: this.agentId,
      key,
      value,
      durability: "permanent",
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Semantic search. The client signs as its own agent; `opts.agentId` names
   * the reader whose read scope the search resolves (that reader's memories
   * plus other agents' non-private memories). Defaults to the signing agent.
   */
  async search(query: string, limit = 5, opts: { agentId?: string } = {}): Promise<SearchResult[]> {
    const result = await this.request<{ results: SearchResult[] }>(
      "POST",
      "/SemanticSearch",
      { agentId: opts.agentId ?? this.agentId, q: query, limit },
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


  /**
   * Read the record a governance write will land on. A governance update must
   * not proceed on unknown state: a failed or incomplete read refuses by name
   * before any write is sent.
   */
  private async readGovernedMemory(id: string): Promise<Memory> {
    let record: Memory;
    try {
      record = await this.request<Memory>("GET", `/Memory/${encodeURIComponent(id)}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`refusing to update memory ${id}: the read failed (${detail})`);
    }
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.agentId !== "string" ||
      typeof record.content !== "string"
    ) {
      throw new Error(`refusing to update memory ${id}: Flair returned an incomplete record`);
    }
    return record;
  }

  /**
   * Send a merge-request PATCH carrying only the governance fields. The read
   * first is the gate above; the PATCH itself merges server-side, so a
   * full-record PUT cannot rewrite a projected read and drop unprojected
   * fields.
   */
  private async patchGovernedMemory(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.readGovernedMemory(id);
    await this.request("PATCH", `/Memory/${encodeURIComponent(id)}`, patch);
  }

  async approveMemory(id: string): Promise<void> {
    throw promotionUnsupported("approve", id);
  }

  async rejectMemory(id: string): Promise<void> {
    throw promotionUnsupported("reject", id);
  }

  async archiveMemory(id: string): Promise<void> {
    await this.patchGovernedMemory(id, {
      archived: true,
      archivedBy: this.agentId,
      archivedAt: new Date().toISOString(),
    });
  }

  async unarchiveMemory(id: string): Promise<void> {
    await this.patchGovernedMemory(id, {
      archived: false,
      archivedBy: null,
      archivedAt: null,
    });
  }

  async purgeMemory(id: string): Promise<void> {
    await this.request("DELETE", `/Memory/${encodeURIComponent(id)}`);
  }

  async proposeMemory(id: string, content: string, tags?: string[]): Promise<void> {
    await this.request("PUT", `/Memory/${encodeURIComponent(id)}`, {
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
    await this.request("PUT", `/Soul/${encodeURIComponent(id)}`, {
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
    await this.request("DELETE", `/Soul/${encodeURIComponent(id)}`);
  }



  async updateAgent(agentId: string, patch: Partial<FlairAgent>): Promise<void> {
    const existing = await this.getAgent(agentId);
    if (!existing) throw new Error(`Agent ${agentId} not found`);
    await this.request("PUT", `/Agent/${encodeURIComponent(agentId)}`, { ...existing, ...patch });
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
        // Harper requires full ISO with milliseconds (.000Z) and no encoding of colons.
        `/OrgEventCatchup/${encodeURIComponent(participantId)}?since=${since.toISOString()}`,
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

  // ─── Skill governance (ops-31.4) ─────────────────────────────────────────

  async scanSkill(content: string): Promise<SkillScanResult> {
    return this.request<SkillScanResult>("POST", "/SkillScan/", { content });
  }

  async listSkills(agentId: string): Promise<SkillAssignment[]> {
    const allSoul = await this.request<SkillAssignment[]>(
      "GET",
      `/Soul/?agentId=${encodeURIComponent(agentId)}`,
    );
    return allSoul.filter((s) => s.key === "skill-assignment");
  }

  async registerSkill(
    agentId: string,
    skill: {
      name: string;
      priority?: "critical" | "high" | "standard" | "low";
      source: string;
      version: string;
      content: string;
    },
  ): Promise<void> {
    const id = `${agentId}-skill-assignment-${skill.name}`;
    const metadata = JSON.stringify({
      source: skill.source,
      version: skill.version,
      hash: skill.version,
      reviewedAt: new Date().toISOString(),
      reviewedBy: this.agentId,
      status: "active",
    });
    await this.request("PUT", `/Soul/${encodeURIComponent(id)}`, {
      id,
      agentId,
      key: "skill-assignment",
      value: skill.name,
      priority: skill.priority ?? "standard",
      metadata,
      durability: "permanent",
      createdAt: new Date().toISOString(),
    });
  }

  async revokeSkill(agentId: string, skillName: string): Promise<void> {
    const id = `${agentId}-skill-assignment-${skillName}`;
    await this.request("DELETE", `/Soul/${encodeURIComponent(id)}`);
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

export function defaultFlairKeyPath(agentId: string): string {
  return join(homedir(), ".tps", "identity", `${agentId}.key`);
}

export function createFlairClient(
  agentId: string,
  baseUrl: string | undefined,
  keyPath: string,
): FlairClient {
  return new FlairClient({
    agentId,
    baseUrl: baseUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926",
    keyPath,
  });
}
