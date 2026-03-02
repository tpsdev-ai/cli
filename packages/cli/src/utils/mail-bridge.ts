/**
 * TPS OpenClaw Mail Bridge
 *
 * Standalone bridge process connecting OpenClaw channels (Discord, etc.)
 * to TPS mail. Runs as a long-lived daemon.
 *
 * Security:
 *   - Inbound POST /inbound requires a bearer token (BRIDGE_TOKEN env var or
 *     config.inboundToken). Requests without a valid token are rejected 401.
 *   - agentId from envelope is validated against /^[a-zA-Z0-9_-]{1,64}$/ before
 *     being used as a mailbox directory name (prevents path traversal).
 *   - Bridge writes X-TPS-Trust and X-TPS-Sender headers into mail so EventLoop
 *     can determine trust level for tool access.
 *   - Outbound delivery errors are logged but non-fatal.
 *   - Binds to 127.0.0.1 only — never 0.0.0.0.
 *
 * Flows:
 *   Inbound  (OpenClaw → Agent):  POST /inbound → validate → write mailbox
 *   Outbound (Agent → OpenClaw):  watch bridge mailbox → POST OpenClaw API
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BridgeEnvelope {
  channel: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  replyTo?: string;
  /**
   * Inbound: target agent to route to.
   * Must match /^[a-zA-Z0-9_-]{1,64}$/ — validated before use.
   */
  agentId?: string;
  timestamp: string;
}

export interface BridgeConfig {
  /** Port for the inbound HTTP webhook listener. Default: 7891 */
  port?: number;
  /** OpenClaw message API URL. Default: http://127.0.0.1:3000/api/message */
  openClawUrl?: string;
  /** Agent ID for the bridge's own TPS mailbox. Default: openclaw-bridge */
  bridgeAgentId?: string;
  /** TPS mail directory root. Default: ~/.tps/mail */
  mailDir?: string;
  /** Default target agent when envelope lacks agentId. Default: anvil */
  defaultAgentId?: string;
  /**
   * Bearer token required on POST /inbound.
   * Falls back to BRIDGE_TOKEN env var. If neither set, inbound is DISABLED
   * for safety — requests return 503 with a clear error message.
   */
  inboundToken?: string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

/**
 * Constant-time bearer token comparison.
 * Returns false if either side is empty or lengths differ.
 */
function checkToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided, "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Mail helpers ─────────────────────────────────────────────────────────────

function mailboxDir(mailDir: string, agentId: string): { fresh: string; cur: string } {
  const base = join(mailDir, agentId);
  return {
    fresh: join(base, "new"),
    cur: join(base, "cur"),
  };
}

interface MailHeaders {
  "X-TPS-Trust": "user" | "internal" | "external";
  "X-TPS-Sender": string;
  "X-TPS-Channel"?: string;
}

function sendMail(
  mailDir: string,
  to: string,
  from: string,
  body: string,
  headers?: MailHeaders,
): void {
  const { fresh } = mailboxDir(mailDir, to);
  mkdirSync(fresh, { recursive: true });

  const id = `${Date.now()}-${randomUUID()}`;
  const msg = {
    id,
    from,
    to,
    timestamp: new Date().toISOString(),
    headers: headers ?? {},
    body,
  };
  writeFileSync(join(fresh, `${id}.json`), JSON.stringify(msg, null, 2), "utf-8");
}

// ─── HTTP body reader ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Outbound: watch bridge mailbox, POST to OpenClaw ─────────────────────────

async function postToOpenClaw(openClawUrl: string, envelope: BridgeEnvelope): Promise<void> {
  const res = await fetch(openClawUrl, {
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

function watchOutbox(
  mailDir: string,
  bridgeAgentId: string,
  openClawUrl: string,
  log: (msg: string) => void,
): () => void {
  const { fresh, cur } = mailboxDir(mailDir, bridgeAgentId);
  mkdirSync(fresh, { recursive: true });
  mkdirSync(cur, { recursive: true });

  const process_ = (file: string) => {
    if (!file.endsWith(".json")) return;
    const fullPath = join(fresh, file);
    if (!existsSync(fullPath)) return;

    let envelope: BridgeEnvelope;
    try {
      const raw = readFileSync(fullPath, "utf-8");
      const msg = JSON.parse(raw);
      // Body may be a JSON string (from tps mail send) or a plain string
      envelope = typeof msg.body === "string" ? JSON.parse(msg.body) : msg.body;
    } catch (e) {
      log(`[bridge:outbound] Failed to parse mail ${file}: ${e}`);
      renameSync(fullPath, join(cur, file));
      return;
    }

    renameSync(fullPath, join(cur, file));

    postToOpenClaw(openClawUrl, envelope).then(() => {
      log(`[bridge:outbound] Sent reply to ${envelope.channel}/${envelope.channelId}`);
    }).catch((e) => {
      log(`[bridge:outbound] OpenClaw delivery failed: ${e}`);
    });
  };

  try {
    readdirSync(fresh).filter((f) => f.endsWith(".json")).forEach(process_);
  } catch {}

  const watcher = watch(fresh, (_event, filename) => {
    if (filename) process_(filename.toString());
  });

  return () => { try { watcher.close(); } catch {} };
}

// ─── Inbound: HTTP server ────────────────────────────────────────────────────

function startInboundServer(
  port: number,
  mailDir: string,
  bridgeAgentId: string,
  defaultAgentId: string,
  inboundToken: string | undefined,
  log: (msg: string) => void,
): { stop: () => void } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health — no auth required
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bridge: bridgeAgentId }));
      return;
    }

    // All other routes require auth
    if (!inboundToken) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Bridge inbound is disabled: no BRIDGE_TOKEN configured. Set BRIDGE_TOKEN env var or pass --inbound-token.",
      }));
      return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!checkToken(provided, inboundToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing Bearer token" }));
      return;
    }

    // Inbound envelope
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

      // Validate agentId — prevent path traversal / mailbox forgery
      const rawAgentId = envelope.agentId;
      if (rawAgentId !== undefined && !validateAgentId(rawAgentId)) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `Invalid agentId '${rawAgentId}': must match /^[a-zA-Z0-9_-]{1,64}$/`,
        }));
        return;
      }

      const targetAgent = rawAgentId ?? defaultAgentId;
      const bodyJson = JSON.stringify(envelope);

      // Trust level: messages via bridge are "external" by default.
      // Only elevate to "internal" if the envelope explicitly says so AND
      // the bearer token was verified (already done above).
      const headers: MailHeaders = {
        "X-TPS-Trust": "external",
        "X-TPS-Sender": envelope.senderId,
        "X-TPS-Channel": `${envelope.channel}:${envelope.channelId}`,
      };

      try {
        sendMail(mailDir, targetAgent, bridgeAgentId, bodyJson, headers);
        log(`[bridge:inbound] ${envelope.channel}/${envelope.senderId} → ${targetAgent}`);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deliveredTo: targetAgent }));
      } catch (e) {
        log(`[bridge:inbound] Mail delivery failed: ${e}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /inbound or GET /health" }));
  });

  server.listen(port, "127.0.0.1", () => {
    log(`[bridge:inbound] Listening on http://127.0.0.1:${port}/inbound`);
    if (!inboundToken) {
      log(`[bridge:inbound] ⚠️  No BRIDGE_TOKEN set — inbound POST /inbound is DISABLED`);
    }
  });

  return { stop: () => server.close() };
}

// ─── PID lifecycle ────────────────────────────────────────────────────────────

const BRIDGE_PID_PATH = join(homedir(), ".tps", "run", "mail-bridge.pid");

export function bridgeStatus(): { running: boolean; pid?: number; port?: number } {
  if (!existsSync(BRIDGE_PID_PATH)) return { running: false };
  try {
    const raw = JSON.parse(readFileSync(BRIDGE_PID_PATH, "utf-8"));
    process.kill(raw.pid, 0);
    return { running: true, pid: raw.pid, port: raw.port };
  } catch {
    return { running: false };
  }
}

export function startBridgeDaemon(config: BridgeConfig = {}): void {
  const port = config.port ?? 7891;
  const openClawUrl = config.openClawUrl ?? process.env.OPENCLAW_MESSAGE_URL ?? "http://127.0.0.1:3000/api/message";
  const bridgeAgentId = config.bridgeAgentId ?? "openclaw-bridge";
  const mailDir = config.mailDir ?? join(homedir(), ".tps", "mail");
  const defaultAgentId = config.defaultAgentId ?? "anvil";
  const inboundToken = config.inboundToken ?? process.env.BRIDGE_TOKEN;

  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

  mkdirSync(join(homedir(), ".tps", "run"), { recursive: true });
  writeFileSync(BRIDGE_PID_PATH, JSON.stringify({ pid: process.pid, port }), "utf-8");

  const stopOutbound = watchOutbox(mailDir, bridgeAgentId, openClawUrl, log);
  const inbound = startInboundServer(port, mailDir, bridgeAgentId, defaultAgentId, inboundToken, log);

  log(`[bridge] TPS OpenClaw Mail Bridge started (bridgeAgentId=${bridgeAgentId}, defaultAgent=${defaultAgentId})`);
  log(`[bridge] OpenClaw URL: ${openClawUrl}`);
  if (!inboundToken) {
    log(`[bridge] ⚠️  BRIDGE_TOKEN not set — POST /inbound is disabled until token is configured`);
  }

  const shutdown = () => {
    log("[bridge] Shutting down...");
    stopOutbound();
    inbound.stop();
    rmSync(BRIDGE_PID_PATH, { force: true });
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export { sendMail, mailboxDir };
