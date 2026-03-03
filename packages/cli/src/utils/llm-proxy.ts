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
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
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

type Provider = "anthropic" | "openai";

function readSecretFile(name: string): string | null {
  const p = join(homedir(), ".tps", "secrets", name);
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : null;
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
    "Authorization": provider === "openai" ? providerCfg.authHeader : "",
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = providerCfg.authHeader.replace("x-api-key: ", "");
    headers["anthropic-version"] = "2023-06-01";
    delete headers.Authorization;
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
    const match = (req.url ?? "").match(/^\/proxy\/(anthropic|openai)(\/.*)?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown proxy path. Use /proxy/anthropic/... or /proxy/openai/..." }));
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
