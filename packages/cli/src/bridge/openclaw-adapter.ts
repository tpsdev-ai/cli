/**
 * OpenClaw Bridge Adapter
 *
 * Inbound:  HTTP server on localhost receives POSTs from OpenClaw
 * Outbound: POSTs to OpenClaw message API
 *
 * Auth: TPS-Ed25519 signature verification on inbound requests.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:bridge:openclaw");


// ─── Ed25519 verification ─────────────────────────────────────────────────────

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

async function verifyTpsEd25519(
  authHeader: string,
  method: string,
  urlPath: string,
): Promise<{ agentId: string } | null> {
  if (!authHeader.startsWith("TPS-Ed25519 ")) return null;
  const parts = authHeader.slice(12).split(":");
  if (parts.length !== 4) return null;
  const [agentId, ts, nonce, sigB64] = parts;
  if (!AGENT_ID_RE.test(agentId)) return null;

  // 30s window
  const now = Date.now();
  const reqTs = parseInt(ts, 10);
  if (isNaN(reqTs) || Math.abs(now - reqTs) > 30_000) return null;

  // Load public key
  const pubPath = join(process.env.HOME ?? homedir(), ".tps", "identity", `${agentId}.pub`);
  let pubKeyRaw: Buffer;
  try {
    pubKeyRaw = Buffer.from(readFileSync(pubPath, "utf-8").trim(), "base64");
  } catch {
    return null;
  }

  const spkiBuf = Buffer.concat([SPKI_ED25519_PREFIX, pubKeyRaw]);
  const key = crypto.createPublicKey({ key: spkiBuf, format: "der", type: "spki" });

  const payload = `${agentId}:${ts}:${nonce}:${method}:${urlPath}`;
  const sig = Buffer.from(sigB64, "base64");
  const valid = crypto.verify(null, Buffer.from(payload), key, sig);
  return valid ? { agentId } : null;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface OpenClawAdapterConfig {
  /** Inbound listener port. Default: 7891 */
  port?: number;
  /** OpenClaw message API URL */
  openClawUrl?: string;
}

export class OpenClawAdapter implements BridgeAdapter {
  readonly name = "openclaw";
  private server: ReturnType<typeof createServer> | null = null;
  private readonly port: number;
  private readonly openClawUrl: string;
  private log: (msg: string) => void;

  constructor(config: OpenClawAdapterConfig = {}, log?: (msg: string) => void) {
    this.port = config.port ?? 7891;
    this.openClawUrl = config.openClawUrl ?? process.env.OPENCLAW_MESSAGE_URL ?? "http://127.0.0.1:3000/api/message";
    this.log = log ?? ((msg) => slog(`${new Date().toISOString()} ${msg}`));
  }

  async start(onInbound: (envelope: BridgeEnvelope) => string): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", adapter: "openclaw" }));
        return;
      }

      // All other routes require Ed25519 auth
      const authHeader = String(req.headers["authorization"] ?? "");
      const sender = await verifyTpsEd25519(authHeader, req.method ?? "GET", req.url ?? "/");
      if (!sender) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing TPS-Ed25519 signature" }));
        return;
      }

      if (req.method === "POST" && req.url === "/inbound") {
        let envelope: BridgeEnvelope;
        try {
          const body = await readBody(req);
          envelope = JSON.parse(body.toString("utf-8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        if (!envelope.content || !envelope.channel) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields: content, channel" }));
          return;
        }

        // Validate agentId
        const rawAgentId = envelope.agentId;
        if (rawAgentId !== undefined && !AGENT_ID_RE.test(rawAgentId)) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid agentId '${rawAgentId}'` }));
          return;
        }

        try {
          const deliveredTo = onInbound(envelope);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deliveredTo }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.log(`[openclaw] Listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    const res = await fetch(this.openClawUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: envelope.channel,
        channelId: envelope.channelId,
        replyTo: envelope.replyTo,
        content: envelope.content,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenClaw API ${res.status}: ${txt.slice(0, 200)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
