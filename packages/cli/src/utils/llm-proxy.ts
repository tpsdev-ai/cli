/**
 * TPS LLM Proxy — localhost HTTP proxy that holds provider API keys.
 *
 * Agent processes never hold API keys. They authenticate to this proxy
 * using their Ed25519 identity, and the proxy forwards requests to the
 * LLM provider (Anthropic, OpenAI, etc.).
 *
 * Security model (Sherlock sign-off, ops-36):
 *   - Agents authenticate with TPS-Ed25519 signature
 *   - Proxy verifies against registered public keys in ~/.tps/identity/
 *   - Proxy holds API keys in env vars (supervisor process scope only)
 *   - Agent nono profile allows only localhost networking
 *
 * Usage:
 *   tps agent proxy start [--port 6459]
 *   tps agent proxy stop
 *   tps agent proxy status
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 6459;
const WINDOW_MS = 30_000; // 30-second replay window

// ─── Auth ─────────────────────────────────────────────────────────────────────
function verifyRequest(authHeader: string, method: string, path: string): string | null {
  // Parse TPS-Ed25519 <agentId>:<ts>:<nonce>:<sigBase64>
  // Uses split() instead of regex to avoid ReDoS (js/polynomial-redos)
  if (!authHeader.startsWith("TPS-Ed25519 ")) return null;
  const payload = authHeader.slice("TPS-Ed25519 ".length);
  const parts = payload.split(":");
  if (parts.length < 4) return null;
  const agentId = parts[0];
  if (!agentId || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) return null;
  const tsStr = parts[1];
  const nonce = parts[2];
  const sigB64 = parts.slice(3).join(":");
  const ts = parseInt(tsStr, 10);
  const now = Date.now();

  if (Math.abs(now - ts) > WINDOW_MS) return null; // replay window

  const pubPath = join(homedir(), ".tps", "identity", `${agentId}.pub`);
  if (!existsSync(pubPath)) return null;

  try {
    const pubRaw = readFileSync(pubPath);
    // Support both raw 32-byte binary and JSON with hex publicKey
    let pubKeyBuf: Buffer;
    if (pubRaw.length === 32) {
      pubKeyBuf = pubRaw;
    } else {
      const pubMeta = JSON.parse(pubRaw.toString("utf-8"));
      const pubKeyHex: string = pubMeta.signing?.publicKey ?? pubMeta.publicKey;
      pubKeyBuf = Buffer.from(pubKeyHex, "hex");
    }

    // Reconstruct signed payload (matches FlairClient format)
    const payload = `${agentId}:${tsStr}:${nonce}:${method}:${path}`;

    // Ed25519 verify — import raw 32-byte public key
    const pubKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 SPKI header (12 bytes)
        Buffer.from("302a300506032b6570032100", "hex"),
        pubKeyBuf,
      ]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(null, Buffer.from(payload), pubKey, Buffer.from(sigB64, "base64"))
      ? agentId
      : null;
  } catch {
    return null;
  }
}

// ─── Provider forwarding ──────────────────────────────────────────────────────

type Provider = "anthropic" | "openai" | "openai-oauth" | "claude-oauth";

function readSecretFile(name: string): string | null {
  const p = join(homedir(), ".tps", "secrets", name);
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : null;
}

// ─── Claude OAuth token management ────────────────────────────────────────────

interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // milliseconds epoch
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const OAUTH_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
// Refresh 5 minutes before actual expiry
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function readClaudeOAuthCredentials(): ClaudeOAuthCredentials | null {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return null;
    const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function writeClaudeOAuthCredentials(creds: ClaudeOAuthCredentials): void {
  try {
    const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8");
    const data = JSON.parse(raw);
    data.claudeAiOauth = creds;
    // Atomic write: write to tmp then rename to avoid corruption on crash
    const tmp = `${CLAUDE_CREDENTIALS_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, CLAUDE_CREDENTIALS_PATH);
  } catch (err) {
    console.error("[llm-proxy] Failed to write OAuth credentials:", err);
  }
}

async function _doRefreshOAuthToken(creds: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
  const res = await fetch(OAUTH_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      // client_id is required by Anthropic's OAuth token endpoint
      client_id: "claude-code",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const updated: ClaudeOAuthCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  writeClaudeOAuthCredentials(updated);
  return updated;
}

/**
 * Singleton refresh promise — ensures only one refresh call is in-flight at a
 * time. This prevents refresh-token rotation revocation: if two concurrent
 * requests both see an expired token, only one actually calls the endpoint;
 * the second awaits the same promise.
 */
let _refreshPromise: Promise<ClaudeOAuthCredentials> | null = null;

async function getValidOAuthToken(): Promise<string> {
  const creds = readClaudeOAuthCredentials();
  if (!creds) throw new Error("Claude OAuth credentials not found at ~/.claude/.credentials.json");

  const needsRefresh = Date.now() >= creds.expiresAt - OAUTH_EXPIRY_BUFFER_MS;
  if (!needsRefresh) return creds.accessToken;

  // Coalesce concurrent refresh attempts into a single in-flight promise
  if (!_refreshPromise) {
    _refreshPromise = _doRefreshOAuthToken(creds).finally(() => {
      _refreshPromise = null;
    });
  }

  const validCreds = await _refreshPromise;
  return validCreds.accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────


// ─── OpenAI OAuth token management ───────────────────────────────────────────

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface OpenAIOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

function readOpenAIOAuthCredentials(): OpenAIOAuthCredentials | null {
  const home = process.env.HOME || homedir();
  const authPath = join(home, ".tps", "auth", "openai.json");
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as any;
    if (!data.accessToken || !data.refreshToken) return null;
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Number(data.expiresAt || 0),
      clientId: String(data.clientId || ""),
    };
  } catch {
    return null;
  }
}

function writeOpenAIOAuthCredentials(creds: OpenAIOAuthCredentials): void {
  const home = process.env.HOME || homedir();
  const authPath = join(home, ".tps", "auth", "openai.json");
  try {
    // Read existing file to preserve all fields (StoredCredentials format)
    let data: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      data = JSON.parse(readFileSync(authPath, "utf-8"));
    }
    data.accessToken = creds.accessToken;
    data.refreshToken = creds.refreshToken;
    data.expiresAt = creds.expiresAt;
    data.clientId = creds.clientId;

    // Atomic write: tmp → rename
    const tmpPath = authPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, authPath);
  } catch (err) {
    console.error("[llm-proxy] Failed to write OpenAI OAuth credentials:", err);
  }
}

async function refreshOpenAIOAuthToken(creds: OpenAIOAuthCredentials): Promise<OpenAIOAuthCredentials> {
  if (!creds.clientId) {
    throw new Error("OpenAI OAuth refresh requires clientId. Re-login with: tps auth login openai");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
  });

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Do NOT log response body — may contain token details
    throw new Error(`OpenAI OAuth token refresh failed (${res.status})`);
  }

  const token = (await res.json()) as any;
  const updated: OpenAIOAuthCredentials = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    clientId: creds.clientId,
  };

  writeOpenAIOAuthCredentials(updated);

  // Also sync back to Codex CLI auth.json if present
  syncOpenAIToCodexCli(updated);

  return updated;
}

function syncOpenAIToCodexCli(creds: OpenAIOAuthCredentials): void {
  const home = process.env.HOME || homedir();
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const candidates = [
    join(codexHome, "auth.json"),
    join(home, ".config", "codex", "auth.json"),
  ];
  for (const credPath of candidates) {
    if (!existsSync(credPath)) continue;
    try {
      const data = JSON.parse(readFileSync(credPath, "utf-8"));
      if ("accessToken" in data) data.accessToken = creds.accessToken;
      if ("access_token" in data) data.access_token = creds.accessToken;
      if ("refreshToken" in data) data.refreshToken = creds.refreshToken;
      if ("refresh_token" in data) data.refresh_token = creds.refreshToken;
      if ("expiresAt" in data) data.expiresAt = creds.expiresAt;
      if ("expires_at" in data) data.expires_at = creds.expiresAt;
      const tmpPath = credPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmpPath, credPath);
      return;
    } catch {
      // best-effort
    }
  }
}

let _openaiRefreshPromise: Promise<OpenAIOAuthCredentials> | null = null;

async function getValidOpenAIOAuthToken(): Promise<string> {
  const creds = readOpenAIOAuthCredentials();
  if (!creds) throw new Error("OpenAI OAuth credentials not found. Run: tps auth login openai");

  const needsRefresh = creds.expiresAt - Date.now() < 5 * 60 * 1000;
  if (!needsRefresh) return creds.accessToken;

  if (!_openaiRefreshPromise) {
    _openaiRefreshPromise = refreshOpenAIOAuthToken(creds).finally(() => {
      _openaiRefreshPromise = null;
    });
  }
  const validCreds = await _openaiRefreshPromise;
  return validCreds.accessToken;
}

function getProviderConfig(provider: Provider): { baseUrl: string; authHeader: string } | null {
  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY ?? readSecretFile("anthropic-api-key");
    if (!key) return null;
    return {
      baseUrl: "https://api.anthropic.com",
      authHeader: `x-api-key: ${key}`,
    };
  }
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY ?? readSecretFile("openai-api-key");
    if (!key) return null;
    return {
      baseUrl: "https://api.openai.com",
      authHeader: `Bearer ${key}`,
    };
  }
  // claude-oauth: dynamic, fetched per-request in forwardRequest
  if (provider === "claude-oauth") {
    return { baseUrl: "https://api.anthropic.com", authHeader: "" };
  }
  // openai-oauth: dynamic, fetched per-request via getValidOpenAIOAuthToken
  if (provider === "openai-oauth") {
    return { baseUrl: "https://api.openai.com", authHeader: "" };
  }
  return null;
}

async function forwardRequest(
  providerCfg: { baseUrl: string; authHeader: string },
  provider: Provider,
  path: string,
  method: string,
  body: Buffer,
  contentType: string,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = `${providerCfg.baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = providerCfg.authHeader.replace("x-api-key: ", "");
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "claude-oauth") {
    const token = await getValidOAuthToken();
    headers["Authorization"] = `Bearer ${token}`;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "openai") {
    headers["Authorization"] = providerCfg.authHeader;
  } else if (provider === "openai-oauth") {
    const token = await getValidOpenAIOAuthToken();
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Force uncompressed response — proxy passes raw bytes to agent, no decompression
  headers["accept-encoding"] = "identity";

  const res = await fetch(url, {
    method,
    headers,
    body: body.length > 0 ? body as unknown as BodyInit : undefined,
  });

  const responseBody = Buffer.from(await res.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    // Strip content-encoding so downstream doesn't attempt decompression
    if (key.toLowerCase() !== "content-encoding") {
      responseHeaders[key] = value;
    }
  });

  return { status: res.status, headers: responseHeaders, body: responseBody };
}

// ─── Server ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createLLMProxy(port = DEFAULT_PORT): { start: () => Promise<void>; stop: () => void } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check (no auth required)
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port }));
      return;
    }

    // Auth
    const auth = req.headers.authorization as string | undefined;
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Authorization header" }));
      return;
    }

    const agentId = verifyRequest(auth, req.method ?? "GET", req.url ?? "/");
    if (!agentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired signature" }));
      return;
    }

    // Route: /proxy/<provider>/<path>
    const match = (req.url ?? "").match(/^\/proxy\/(anthropic|openai|openai-oauth|claude-oauth)(\/.*)?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown proxy path. Use /proxy/anthropic/..., /proxy/openai/..., /proxy/openai-oauth/..., or /proxy/claude-oauth/..." }));
      return;
    }

    const provider = match[1] as Provider;
    const upstreamPath = match[2] ?? "/";

    const providerCfg = getProviderConfig(provider);
    if (!providerCfg) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `No API key configured for provider: ${provider}` }));
      return;
    }

    try {
      const body = await readBody(req);
      const contentType = (req.headers["content-type"] as string) || "application/json";

      const upstream = await forwardRequest(
        providerCfg,
        provider,
        upstreamPath,
        req.method ?? "POST",
        body,
        contentType,
      );

      // Strip hop-by-hop headers
      const { "transfer-encoding": _, "connection": __, ...safeHeaders } = upstream.headers;
      res.writeHead(upstream.status, safeHeaders);
      res.end(upstream.body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream error: ${String(e)}` }));
    }
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => {
          console.log(`TPS LLM proxy listening on http://127.0.0.1:${port}`);
          resolve();
        });
        server.on("error", reject);
      }),
    stop: () => {
      server.close();
    },
  };
}

// ─── PID-based lifecycle (for 'tps agent proxy start') ───────────────────────

const PROXY_PID_PATH = join(homedir(), ".tps", "run", "llm-proxy.pid");

export function startProxyDaemon(port = DEFAULT_PORT): void {
  const proxy = createLLMProxy(port);
  proxy.start().catch((e) => {
    console.error(`Failed to start LLM proxy: ${e}`);
    process.exit(1);
  });

  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(homedir(), ".tps", "run"), { recursive: true });
  writeFileSync(PROXY_PID_PATH, `${process.pid}\n`, "utf-8");

  process.once("SIGTERM", () => {
    proxy.stop();
    rmSync(PROXY_PID_PATH, { force: true });
    process.exit(0);
  });
  process.once("SIGINT", () => {
    proxy.stop();
    rmSync(PROXY_PID_PATH, { force: true });
    process.exit(0);
  });
}

export function proxyStatus(): { running: boolean; pid?: number; port?: number } {
  if (!existsSync(PROXY_PID_PATH)) return { running: false };
  try {
    const pid = parseInt(readFileSync(PROXY_PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return { running: true, pid, port: DEFAULT_PORT };
  } catch {
    return { running: false };
  }
}
