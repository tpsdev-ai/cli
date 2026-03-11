import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { countInboxMessages, MAX_INBOX_MESSAGES, sendMessage } from "./mail.js";
import { LoopDetector } from "./loop-detector.js";
import { FileSystemTransport, resolveTransport, TransportRegistry, type TransportChannel, type TpsMessage } from "./transport.js";
import { NoiseIkTransport } from "./noise-ik-transport.js";
import { WsNoiseTransport } from "./ws-noise-transport.js";
import { WireDeliveryTransport } from "./wire-delivery.js";
import { loadHostIdentity, lookupBranch } from "./identity.js";
import { MSG_MAIL_DELIVER, MSG_MAIL_ACK, MSG_HEARTBEAT, MailDeliverBodySchema } from "./wire-mail.js";
import { registerFlairProxyHandler } from "./flair-proxy-host.js";
import { clearHostState, writeHostState, type HostConnectionState } from "./connection-state.js";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:relay");


export interface RelayMessage {
  id?: string;
  from?: string;
  to: string;
  body: string;
  timestamp?: string;
  read?: boolean;
  origin?: string;
  error?: string;
}

function resolveDeliveryPath(agentId: string): string {
  const branchDir = join(process.env.HOME || homedir(), ".tps", "branch-office");
  if (!existsSync(branchDir)) return join(branchDir, agentId, "mail");

  // Case 1: agentId is a team (has team.json in its root)
  const teamPath = join(branchDir, agentId);
  const teamSidecar = join(teamPath, "team.json");
  if (existsSync(teamSidecar)) {
    try {
      const sidecar = JSON.parse(readFileSync(teamSidecar, "utf-8"));
      if (sidecar.workspaceMail) return sidecar.workspaceMail;
    } catch {}
    return join(teamPath, "workspace", "mail");
  }

  // Case 2: agentId is a member of a team
  try {
    const teams = readdirSync(branchDir).filter(d => {
      return existsSync(join(branchDir, d, "team.json"));
    });

    for (const team of teams) {
      const sidecarPath = join(branchDir, team, "team.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      if (Array.isArray(sidecar.members) && sidecar.members.includes(agentId)) {
        return sidecar.workspaceMail || join(branchDir, team, "workspace", "mail");
      }
    }
  } catch {
    // Fallback to per-agent path on any read error
  }

  // Case 3: Legacy per-agent path
  return join(branchDir, agentId, "mail");
}

function branchRoot(agentId: string): string {
  return resolveDeliveryPath(agentId);
}

function assertAgent(agentId: string): void {
  const safe = sanitizeIdentifier(agentId);
  if (!agentId || safe !== agentId) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, targetPath);
}

const detectors = new Map<string, LoopDetector>();
const transportRegistry = new TransportRegistry(new FileSystemTransport());

function getDetector(agentId: string): LoopDetector {
  if (!detectors.has(agentId)) {
    detectors.set(agentId, new LoopDetector());
  }
  return detectors.get(agentId)!;
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function processOutboxOnce(agentId: string): Promise<{ processed: number; failed: number }> {
  assertAgent(agentId);
  const root = branchRoot(agentId);
  const outNew = join(root, "outbox", "new");
  const outCur = join(root, "outbox", "cur");
  const outFailed = join(root, "outbox", "failed");
  ensureDir(outNew);
  ensureDir(outCur);
  ensureDir(outFailed);

  const files = readdirSync(outNew).filter((f) => f.endsWith(".json"));
  let processed = 0;
  let failed = 0;

  for (const f of files) {
    const src = join(outNew, f);
    const failedPath = join(outFailed, f);
    try {
      const raw = readFileSync(src, "utf-8");
      const msg = JSON.parse(raw) as RelayMessage;

      // Loop detection — check before delivery
      const detector = getDetector(agentId);
      if (detector.check(String(msg.body ?? ""))) {
        // Move to paused directory instead of delivering
        const outPaused = join(root, "outbox", "paused");
        ensureDir(outPaused);
        renameSync(src, join(outPaused, f));

        // Write warning to WALL.md if it exists
        const wallPath = join(root, "..", "WALL.md");
        if (existsSync(join(root, ".."))) {
          const warning = `\n[${new Date().toISOString()}] ⚠️ LOOP DETECTED: Agent ${agentId} sent duplicate message ${detector.duplicateCount(String(msg.body ?? ""))} times in 5 minutes. Message paused. Review paused/ directory.\n`;
          try {
            appendFileSync(wallPath, warning, "utf-8");
          } catch {}
        }

        failed += 1;
        continue;
      }

      const recipient = msg.to;
      const safeRecipient = sanitizeIdentifier(recipient || "");
      if (!recipient || safeRecipient !== recipient) {
        throw new Error(`Invalid recipient id: ${recipient}`);
      }

      if (Buffer.byteLength(String(msg.body ?? ""), "utf8") > 64 * 1024) {
        throw new Error("Message body exceeds maximum size (64KB)");
      }

      if (countInboxMessages(recipient) >= MAX_INBOX_MESSAGES) {
        throw new Error("Inbox full");
      }

      const transport = resolveTransport(recipient, transportRegistry);
      const result = await transport.deliver({
        from: `container:${agentId}`,
        to: recipient,
        body: Buffer.from(String(msg.body ?? ""), "utf-8"),
        headers: {
          "x-tps-id": msg.id || randomUUID(),
          "x-tps-timestamp": msg.timestamp || new Date().toISOString(),
          "x-tps-origin": "docker-sandbox",
        },
      });

      if (!result.delivered) {
        throw new Error(result.error || `Delivery failed via ${result.transport}`);
      }

      renameSync(src, join(outCur, f));
      processed += 1;
    } catch (e: any) {
      try {
        const raw = existsSync(src) ? readFileSync(src, "utf-8") : "{}";
        const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
        parsed.error = e?.message || "Relay failed";
        atomicWriteJson(failedPath, parsed);
        if (existsSync(src)) {
          try { renameSync(src, join(outFailed, `${Date.now()}-${f}`)); } catch {}
        }
      } catch {
        // fallback: best effort move raw file
        if (existsSync(src)) {
          try { renameSync(src, failedPath); } catch {}
        }
      }
      failed += 1;
    }
  }

  return { processed, failed };
}

export async function connectRemoteBranches(
  registry: TransportRegistry,
  onMail?: (branchId: string, msg: TpsMessage) => void
): Promise<{ connected: string[]; cleanup: () => Promise<void> }> {
  const branchDir = join(process.env.HOME || homedir(), ".tps", "branch-office");
  if (!existsSync(branchDir)) return { connected: [], cleanup: async () => {} };

  const channels: Map<string, TransportChannel> = new Map();
  const connected: string[] = [];

  const entries = readdirSync(branchDir);
  const remoteEntries = entries
    .map((name) => ({ name, path: join(branchDir, name, "remote.json") }))
    .filter((e) => existsSync(e.path))
    .filter((e) => {
      try {
        const remote = JSON.parse(readFileSync(e.path, "utf-8"));
        return remote.transport === "ws" || remote.transport === "tcp";
      } catch {
        return false;
      }
    });
  if (remoteEntries.length === 0) {
    return { connected: [], cleanup: async () => {} };
  }

  const hostKp = await loadHostIdentity();

  for (const name of entries) {
    const remotePath = join(branchDir, name, "remote.json");
    if (!existsSync(remotePath)) continue;

    try {
      const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
      if (remote.transport !== "ws" && remote.transport !== "tcp") continue;

      // Validate host/port from remote.json (S6-A)
      const remoteHost = String(remote.host || "");
      const remotePort = Number(remote.port);
      if (!remoteHost || /[^a-zA-Z0-9._\-:]/.test(remoteHost)) {
        serror(`Remote branch '${name}': invalid host in remote.json`);
        continue;
      }
      if (!Number.isFinite(remotePort) || remotePort <= 0 || remotePort > 65535) {
        serror(`Remote branch '${name}': invalid port in remote.json`);
        continue;
      }

      const branch = lookupBranch(name);
      if (!branch || !branch.encryptionKey) {
        serror(`Remote branch '${name}': not registered or missing encryption key`);
        continue;
      }

      const transport = remote.transport === "ws" ? new WsNoiseTransport(hostKp) : new NoiseIkTransport(hostKp);
      const channel = await transport.connect({
        host: remoteHost,
        port: remotePort,
        branchId: name,
        hostPublicKey: branch.encryptionKey,
      });

      const wireTransport = new WireDeliveryTransport(channel);
      registry.register(name, wireTransport);
      channels.set(name, channel);
      connected.push(name);

      channel.onMessage((msg: TpsMessage) => {
        if (msg.type === MSG_MAIL_DELIVER) {
          onMail?.(name, msg);
        }
      });

      slog(`Connected to remote branch '${name}' at ${remote.host}:${remote.port}`);
    } catch (e: any) {
      serror(`Failed to connect to remote branch '${name}': ${e.message}`);
    }
  }

  const cleanup = async () => {
    for (const [id, ch] of channels) {
      try {
        registry.unregister(id);
        await ch.close();
      } catch {}
    }
    channels.clear();
  };

  return { connected, cleanup };
}

export function handleIncomingMail(branchId: string, msg: TpsMessage): void {
  const parsed = MailDeliverBodySchema.safeParse(msg.body);
  if (!parsed.success) {
    serror(`Invalid MAIL_DELIVER from ${branchId}`);
    return;
  }

  const { to, content, id, from, timestamp } = parsed.data;
  const safe = sanitizeIdentifier(to);
  if (safe !== to) {
    serror(`Invalid recipient in mail from ${branchId}: ${to}`);
    return;
  }

  deliverToSandbox(to, {
    id: id || randomUUID(),
    from: from || branchId,
    to,
    body: content,
    timestamp: timestamp || new Date().toISOString(),
    origin: `remote:${branchId}`,
  });
}

export function startRelay(agentId: string): () => void {
  assertAgent(agentId);

  let remoteCleanup: (() => Promise<void>) | null = null;
  connectRemoteBranches(transportRegistry, (branchId, msg) => {
    handleIncomingMail(branchId, msg);
  })
    .then(({ connected, cleanup }) => {
      remoteCleanup = cleanup;
      if (connected.length > 0) {
        slog(`Connected to ${connected.length} remote branch(es): ${connected.join(", ")}`);
      }
    })
    .catch((e: any) => {
      serror(`Remote branch connection error: ${e.message}`);
    });

  const intervalMs = Number(process.env.TPS_RELAY_POLL_MS || 1000);
  const timer = setInterval(() => {
    processOutboxOnce(agentId).catch(() => {
      // keep relay alive
    });
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    remoteCleanup?.().catch(() => {});
  };
  return stop;
}

export async function deliverToRemoteBranch(
  branchId: string,
  message: RelayMessage
): Promise<void> {
  const branchDir = join(process.env.HOME || homedir(), ".tps", "branch-office", branchId);
  const remotePath = join(branchDir, "remote.json");
  if (!existsSync(remotePath)) {
    throw new Error(`No remote.json for branch: ${branchId}`);
  }

  const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
  const host = String(remote.host || "");
  const port = Number(remote.port);
  const transportType = remote.transport === "tcp" ? "tcp" : "ws";

  const branch = lookupBranch(branchId);
  if (!branch || !branch.encryptionKey) {
    throw new Error(`Remote branch '${branchId}': not registered or missing encryption key`);
  }

  const hostKp = await loadHostIdentity();
  const transport = transportType === "ws" ? new WsNoiseTransport(hostKp) : new NoiseIkTransport(hostKp);
  
  const channel = await transport.connect({
    host,
    port,
    branchId,
    hostPublicKey: branch.encryptionKey,
  });

  try {
    const msgId = message.id || randomUUID();
    const payload = {
      id: msgId,
      from: message.from || "host",
      to: message.to,
      content: message.body,
      timestamp: message.timestamp || new Date().toISOString(),
    };

    const acked = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        channel.offMessage(handler);
        reject(new Error("Delivery timeout (5s)"));
      }, 5000);

      const handler = (msg: TpsMessage) => {
        if (msg.type === MSG_MAIL_ACK && (msg.body as any)?.id === msgId) {
          clearTimeout(timeout);
          channel.offMessage(handler);
          resolve();
        }
      };
      channel.onMessage(handler);
    });

    await channel.send({
      type: MSG_MAIL_DELIVER,
      seq: 0,
      ts: payload.timestamp,
      body: payload,
    });

    await acked;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        channel.offMessage(handler);
        resolve();
      }, 2000);

      const handler = (msg: TpsMessage) => {
        if (msg.type !== MSG_MAIL_DELIVER) return;
        const parsed = MailDeliverBodySchema.safeParse(msg.body);
        if (!parsed.success) return;

        const b = parsed.data;
        try {
          sendMessage(b.to, b.content, b.from);
        } catch {}
      };

      channel.onMessage(handler);
    });
  } finally {
    await channel.close();
  }
}

export async function syncRemoteBranch(branchId: string): Promise<{ received: number }> {
  const branchDir = join(process.env.HOME || homedir(), ".tps", "branch-office", branchId);
  const remotePath = join(branchDir, "remote.json");
  if (!existsSync(remotePath)) {
    throw new Error(`No remote.json for branch: ${branchId}`);
  }

  const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
  const host = String(remote.host || "");
  const port = Number(remote.port);
  const transportType = remote.transport === "tcp" ? "tcp" : "ws";

  const branch = lookupBranch(branchId);
  if (!branch || !branch.encryptionKey) {
    throw new Error(`Remote branch '${branchId}': not registered or missing encryption key`);
  }

  const hostKp = await loadHostIdentity();
  const transport = transportType === "ws" ? new WsNoiseTransport(hostKp) : new NoiseIkTransport(hostKp);
  const channel = await transport.connect({ host, port, branchId, hostPublicKey: branch.encryptionKey });

  let received = 0;
  try {
    await channel.send({ type: MSG_HEARTBEAT, seq: 0, ts: new Date().toISOString(), body: {} });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        channel.offMessage(handler);
        resolve();
      }, 3000);

      const handler = (msg: TpsMessage) => {
        if (msg.type !== MSG_MAIL_DELIVER) return;
        const parsed = MailDeliverBodySchema.safeParse(msg.body);
        if (!parsed.success) return;
        const b = parsed.data;
        try {
          sendMessage(b.to, b.content, b.from);
          received++;
        } catch {}
      };

      channel.onMessage(handler);
    });
  } finally {
    await channel.close().catch(() => {});
  }

  return { received };
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export async function connectAndKeepAlive(
  branchId: string,
  opts: { onMessage?: (msg: TpsMessage) => void } = {}
): Promise<() => Promise<void>> {
  let stopped = false;
  let reconnectCount = 0;
  let currentChannel: TransportChannel | null = null;

  const remotePath = join(process.env.HOME || homedir(), ".tps", "branch-office", branchId, "remote.json");
  if (!existsSync(remotePath)) throw new Error(`No remote.json for branch: ${branchId}`);
  const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
  const branch = lookupBranch(branchId);
  if (!branch?.encryptionKey) throw new Error(`Branch '${branchId}' missing encryption key`);
  const hostKp = await loadHostIdentity();

  const loop = async () => {
    let backoff = RECONNECT_BASE_MS;
    while (!stopped) {
      try {
        const transport = remote.transport === "tcp" ? new NoiseIkTransport(hostKp) : new WsNoiseTransport(hostKp);
        const channel = await transport.connect({
          host: String(remote.host),
          port: Number(remote.port),
          branchId,
          hostPublicKey: branch.encryptionKey!,
        });
        currentChannel = channel;

        const now = new Date().toISOString();
        const state: HostConnectionState = {
          branch: branchId,
          connectedAt: now,
          lastHeartbeatSent: now,
          lastHeartbeatAck: null,
          reconnectCount,
          bytesSent: 0,
          bytesReceived: 0,
          messagesSent: 0,
          messagesReceived: 0,
          pid: process.pid,
        };
        writeHostState(state);

        await channel.send({ type: MSG_HEARTBEAT, seq: 0, ts: now, body: {} });
        state.messagesSent++;
        writeHostState(state);

        const hb = setInterval(async () => {
          if (stopped || !channel.isAlive()) return;
          try {
            await channel.send({ type: MSG_HEARTBEAT, seq: 0, ts: new Date().toISOString(), body: {} });
            state.lastHeartbeatSent = new Date().toISOString();
            state.messagesSent++;
            writeHostState(state);
          } catch {}
        }, HEARTBEAT_INTERVAL_MS);

        registerFlairProxyHandler(channel);

        const handler = (msg: TpsMessage) => {
          state.messagesReceived++;
          state.lastHeartbeatAck = new Date().toISOString();
          writeHostState(state);
          if (msg.type === MSG_MAIL_DELIVER) {
            const parsed = MailDeliverBodySchema.safeParse(msg.body);
            if (parsed.success) {
              const b = parsed.data;
              try { sendMessage(b.to, b.content, b.from); } catch {}
            }
          }
          opts.onMessage?.(msg);
        };
        channel.onMessage(handler);

        while (!stopped && channel.isAlive()) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        clearInterval(hb);
        channel.offMessage(handler);
        try { await channel.close(); } catch {}
        currentChannel = null;
      } catch {}

      reconnectCount++;
      const st = (RECONNECT_BASE_MS * Math.pow(2, Math.min(reconnectCount, 6)));
      const wait = Math.min(st, RECONNECT_MAX_MS);
      if (!stopped) await new Promise((r) => setTimeout(r, wait));
    }
  };

  void loop();

  return async () => {
    stopped = true;
    try { await currentChannel?.close(); } catch {}
    clearHostState(branchId);
  };
}

export function deliverToSandbox(agentId: string, message: RelayMessage): void {
  assertAgent(agentId);
  const root = branchRoot(agentId);
  const inboxNew = join(root, "inbox", "new");
  ensureDir(inboxNew);

  const payload = {
    id: message.id || randomUUID(),
    from: message.from || "host",
    to: message.to,
    body: message.body,
    timestamp: message.timestamp || new Date().toISOString(),
    read: false,
    origin: message.origin || "host",
  };

  const filename = `${timestampPrefix()}-${randomUUID()}.json`;
  atomicWriteJson(join(inboxNew, filename), payload);
}
