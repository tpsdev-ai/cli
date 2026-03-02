/**
 * TPS OpenClaw Mail Bridge
 *
 * Standalone bridge process connecting OpenClaw channels (Discord, etc.)
 * to TPS mail. Runs as a long-lived daemon.
 *
 * Architecture:
 *   Inbound  (OpenClaw → Agent):  HTTP server receives webhook POSTs from
 *                                  OpenClaw, writes envelope to agent mailbox.
 *   Outbound (Agent → OpenClaw):  Watches openclaw-bridge TPS mailbox,
 *                                  POSTs replies to OpenClaw message API.
 *
 * Envelope format (shared inbound/outbound):
 * {
 *   "channel":   "discord",
 *   "channelId": "1477302504369688721",
 *   "senderId":  "284437008405757953",
 *   "senderName": "Nathan",
 *   "content":   "What's next?",
 *   "replyTo":   "1477835831971418243",   // optional
 *   "agentId":   "anvil",                 // inbound: routing target
 *   "timestamp": "2026-03-01T17:11:00Z"
 * }
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
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BridgeEnvelope {
  channel: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  replyTo?: string;
  /** Inbound: target agent. Outbound: set by agent, used for routing. */
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
}

// ─── Mail helpers ─────────────────────────────────────────────────────────────

function mailboxDir(mailDir: string, agentId: string): { fresh: string; cur: string } {
  const base = join(mailDir, agentId);
  return {
    fresh: join(base, "new"),
    cur: join(base, "cur"),
  };
}

function sendMail(mailDir: string, to: string, from: string, body: string): void {
  const { fresh } = mailboxDir(mailDir, to);
  mkdirSync(fresh, { recursive: true });

  const id = `${Date.now()}-${randomUUID()}`;
  const msg = {
    id,
    from,
    to,
    timestamp: new Date().toISOString(),
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

  // Drain existing
  try {
    readdirSync(fresh).filter((f) => f.endsWith(".json")).forEach(process_);
  } catch {}

  const watcher = watch(fresh, (_event, filename) => {
    if (filename) process_(filename.toString());
  });

  return () => { try { watcher.close(); } catch {} };
}

// ─── Inbound: HTTP server, receive from OpenClaw, write to agent mailbox ──────

function startInboundServer(
  port: number,
  mailDir: string,
  bridgeAgentId: string,
  defaultAgentId: string,
  log: (msg: string) => void,
): { stop: () => void } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bridge: bridgeAgentId }));
      return;
    }

    // Inbound envelope from OpenClaw
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

      const targetAgent = envelope.agentId ?? defaultAgentId;
      const body = JSON.stringify(envelope);

      try {
        sendMail(mailDir, targetAgent, bridgeAgentId, body);
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

  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

  // Write PID
  mkdirSync(join(homedir(), ".tps", "run"), { recursive: true });
  writeFileSync(BRIDGE_PID_PATH, JSON.stringify({ pid: process.pid, port }), "utf-8");

  // Start outbound watcher
  const stopOutbound = watchOutbox(mailDir, bridgeAgentId, openClawUrl, log);

  // Start inbound server
  const inbound = startInboundServer(port, mailDir, bridgeAgentId, defaultAgentId, log);

  log(`[bridge] TPS OpenClaw Mail Bridge started (bridgeAgentId=${bridgeAgentId}, defaultAgent=${defaultAgentId})`);
  log(`[bridge] OpenClaw URL: ${openClawUrl}`);

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

// ─── Export for use in commands ───────────────────────────────────────────────

export { sendMail, mailboxDir };
