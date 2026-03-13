import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, openSync, closeSync, watch, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { generateKeyPair, loadKeyPair, saveKeyPair } from "../utils/identity.js";
import { listenForHost, listenForJoin } from "../utils/noise-ik-transport.js";
import { listenForHostWs, listenForJoinWs } from "../utils/ws-noise-transport.js";
import { MailDeliverBodySchema, MSG_MAIL_DELIVER, MSG_MAIL_ACK, MSG_HEARTBEAT } from "../utils/wire-mail.js";
import { startFlairProxy } from "../utils/flair-proxy.js";
import { sendMessage } from "../utils/mail.js";
import { drainOutbox, queueOutboxMessage } from "../utils/outbox.js";
import { clearBranchState, writeBranchState } from "../utils/connection-state.js";
import { discoverManifests } from "../utils/manifest.js";
import { runHandlerPipeline } from "../utils/mail-handler.js";
import type { TransportChannel, TpsMessage, TransportServer } from "../utils/transport.js";

let activeHostChannel: TransportChannel | null = null;

export interface BranchArgs {
  action: "init" | "start" | "stop" | "status" | "log";
  port?: number;
  host?: string;
  transport?: "ws" | "tcp";
  force?: boolean;
  lines?: number;
  follow?: boolean;
}

function tpsRoot(): string {
  return join(process.env.HOME || homedir(), ".tps");
}

function getIdentityDir(): string {
  return process.env.TPS_IDENTITY_DIR || join(tpsRoot(), "identity");
}

function pidPath(): string {
  return join(tpsRoot(), "branch.pid");
}

function logPath(): string {
  return join(tpsRoot(), "branch.log");
}

function confPath(): string {
  return join(tpsRoot(), "branch.conf.json");
}

function hostPath(identityDir: string): string {
  return join(identityDir, "host.json");
}

function logLine(event: string, msg: string): void {
  appendFileSync(logPath(), `[${new Date().toISOString()}] ${event}: ${msg}\n`, "utf-8");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeBranchConf(port: number, host: string, transport: "ws" | "tcp", agentsDir?: string): void {
  writeFileSync(
    confPath(),
    JSON.stringify(
      {
        port,
        host,
        transport,
        agentsDir,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );
}

function readBranchConf(): { port: number; host: string; transport: "ws" | "tcp"; agentsDir?: string } {
  const p = confPath();
  if (!existsSync(p)) throw new Error("branch.conf.json not found. Run `tps branch init` first.");
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const t = raw.transport === "tcp" ? "tcp" : "ws";
  return {
    port: Number(raw.port),
    host: String(raw.host || ""),
    transport: t,
    agentsDir: raw.agentsDir ? String(raw.agentsDir) : undefined
  };
}

async function runInit(args: BranchArgs): Promise<void> {
  const identityDir = getIdentityDir();
  mkdirSync(identityDir, { recursive: true });
  mkdirSync(tpsRoot(), { recursive: true });

  const seedPath = join(identityDir, "branch.seed");
  const hostFile = hostPath(identityDir);

  if (existsSync(hostFile) && !args.force) {
    console.error("Already joined to a host. Use --force to re-initialize.");
    process.exit(1);
  }

  const kp = existsSync(seedPath) && !args.force
    ? loadKeyPair(identityDir, "branch")
    : (() => {
        const created = generateKeyPair();
        saveKeyPair(created, identityDir, "branch");
        return created;
      })();

  const port = args.port ?? 6458;
  const advertiseHost = args.host ?? hostname();
  const transport = args.transport ?? "ws";
  writeBranchConf(port, advertiseHost, transport, undefined);

  const pubkeyB64 = Buffer.from(kp.encryption.publicKey).toString("base64url");
  const sigPubkeyB64 = Buffer.from(kp.signing.publicKey).toString("base64url");
  const token = `tps://join?host=${encodeURIComponent(advertiseHost)}&port=${port}&transport=${transport}&pubkey=${pubkeyB64}&sigpubkey=${sigPubkeyB64}&fp=sha256:${kp.fingerprint}`;

  console.log("Branch identity created.");
  console.log(`Fingerprint: sha256:${kp.fingerprint}`);
  console.log(`Listening on 0.0.0.0:${port}`);
  console.log("\nJoin token (run on host):");
  console.log(`  tps office join <name> \"${token}\"`);
  console.log("\nWaiting for host to connect... (Ctrl+C to cancel)");

  const joined =
    transport === "ws"
      ? await listenForJoinWs(kp, port, 120_001)
      : await listenForJoin(kp, port, 120_001);

  const hostRecord = {
    hostId: joined.hostId,
    publicKey: Buffer.from(joined.hostPubkey).toString("base64url"),
    fingerprint: joined.hostFingerprint,
    joinedAt: new Date().toISOString(),
  };

  writeFileSync(hostFile, JSON.stringify(hostRecord, null, 2), "utf-8");

  await joined.channel.close();
  await joined.server.close();

  console.log(`✓ Joined to host '${joined.hostId}' (sha256:${joined.hostFingerprint})`);

  if (process.env.TPS_BRANCH_NO_DAEMON === "1" || process.env.NODE_ENV === "test") {
    console.log("Branch office ready.");
    return;
  }

  console.log("Starting branch daemon...");
  const outFd = openSync(logPath(), "a");
  const child = spawn(process.execPath, [process.argv[1]!, "branch", "start"], {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, TPS_BRANCH_DAEMON: "1" },
  });
  child.unref();
  try { closeSync(outFd); } catch {}
  if (!child.pid) {
    throw new Error("Failed to spawn branch daemon");
  }
  writeFileSync(pidPath(), `${child.pid}\n`, "utf-8");

  console.log(`Branch daemon running (pid ${child.pid}). Listening on 0.0.0.0:${port}.`);
  console.log(`Log: ${logPath()}`);
}

async function runStart(): Promise<void> {
  if (
    process.env.TPS_BRANCH_DAEMON !== "1" &&
    process.env.TPS_BRANCH_NO_DAEMON !== "1" &&
    process.env.NODE_ENV !== "test"
  ) {
    mkdirSync(tpsRoot(), { recursive: true });
    const outFd = openSync(logPath(), "a");
    const child = spawn(process.execPath, [process.argv[1]!, "branch", "start"], {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: { ...process.env, TPS_BRANCH_DAEMON: "1" },
    });
    child.unref();
    try { closeSync(outFd); } catch {}
    if (!child.pid) throw new Error("Failed to spawn branch daemon");
    writeFileSync(pidPath(), `${child.pid}\n`, "utf-8");
    console.log(`Branch daemon started (pid ${child.pid}). Log: ${logPath()}`);
    process.exit(0);
  }

  const identityDir = getIdentityDir();
  const hostFile = hostPath(identityDir);
  if (!existsSync(hostFile)) {
    throw new Error("Branch is not joined. Run `tps branch init` first.");
  }

  const conf = readBranchConf();
  const kp = loadKeyPair(identityDir, "branch");
  const host = JSON.parse(readFileSync(hostFile, "utf-8"));
  const hostPub = new Uint8Array(Buffer.from(host.publicKey, "base64url"));

  const agentsDir = conf.agentsDir
    ? resolve(join(process.env.HOME || homedir(), ".tps", "branch"), conf.agentsDir)
    : null;

  const manifests = agentsDir ? discoverManifests(agentsDir) : [];

  if (manifests.length > 0) {
    logLine("AGENTS", `Loaded ${manifests.length} manifest(s): ${manifests.map(m => m.name).join(", ")}`);
  }

  function getRegisteredAgents(): string[] {
    try {
      const reg = join(process.env.HOME || homedir(), ".tps", "registry");
      return existsSync(reg)
        ? readdirSync(reg).filter((f: string) => f.endsWith(".meta.json")).map((f: string) => f.replace(".meta.json", ""))
        : [];
    } catch { return []; }
  }

  // Resolve the local agent identity for incoming mail storage.
  // Preference order: TPS_AGENT_ID env → conf.agentId → hostname fragment.
  // This ensures mail is stored under the branch's own identity, not the
  // logical 'to' name used by the sender (which may be a GAL alias).
  function getLocalAgentId(): string {
    if (process.env.TPS_AGENT_ID) return process.env.TPS_AGENT_ID;
    if ((conf as any).agentId) return String((conf as any).agentId);
    // Fall back to hostname fragment (e.g. "tps-anvil" from hostname)
    return hostname().split(".")[0]!;
  }

  const localAgentId = getLocalAgentId();

  let flairProxy: { close: () => void } | null = null;

  const onMessage = async (msg: TpsMessage, channel: TransportChannel) => {
    if (activeHostChannel !== channel) {
      if (activeHostChannel) {
        try { activeHostChannel.close?.(); } catch {}
      }
      activeHostChannel = channel;
    }

    writeBranchState({ connectedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), messagesReceived: 0, messagesPushed: 0 });

    if (msg.type === MSG_HEARTBEAT) {
      for (const item of drainOutbox()) {
        await channel.send({
          type: MSG_MAIL_DELIVER,
          seq: msg.seq + 1,
          ts: new Date().toISOString(),
          body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
        }).catch(() => {});
      }
      logLine("SYNC", "Heartbeat received — drained outbox");
      return;
    }
    if (msg.type !== MSG_MAIL_DELIVER) return;
    const parsed = MailDeliverBodySchema.safeParse(msg.body);
    if (!parsed.success) {
      logLine("WARN", "Invalid MAIL_DELIVER payload");
      return;
    }
    const body = parsed.data;

    const action = await runHandlerPipeline(
      { id: body.id, from: body.from, to: body.to, body: body.content, timestamp: body.timestamp },
      manifests,
      getRegisteredAgents(),
    );

    switch (action.type) {
      case "reply":
        queueOutboxMessage(action.to ?? body.from, action.body ?? "", body.to);
        logLine("HANDLER", `Reply queued to ${action.to ?? body.from}`);
        break;
      case "forward":
        if (action.to) {
          queueOutboxMessage(action.to, action.body ?? body.content, body.to);
          logLine("HANDLER", `Forwarded to ${action.to}`);
        }
        break;
      case "drop":
        logLine("HANDLER", `Message ${body.id} dropped`);
        break;
      case "inbox":
      default:
        // Store under localAgentId (branch's own identity), not body.to.
        // body.to may be a GAL logical name (e.g. "anvil") that differs from
        // the branch's identity dir (e.g. "tps-anvil"). Preserving body.to
        // in the message metadata keeps the original recipient visible.
        try { sendMessage(localAgentId, body.content, body.from); } catch (e: any) {
          logLine("WARN", `Mail write failed: ${e.message}`);
        }
        break;
    }

    await channel.send({ type: MSG_MAIL_ACK, seq: msg.seq, ts: new Date().toISOString(), body: { id: body.id, accepted: true } }).catch(() => {});

    for (const item of drainOutbox()) {
      await channel.send({
        type: MSG_MAIL_DELIVER,
        seq: msg.seq + 1,
        ts: new Date().toISOString(),
        body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
      }).catch(() => {});
    }

    logLine("MAIL", `Received message for ${body.to} (id: ${body.id})`);
  };

  logLine("STARTED", `Listening on 0.0.0.0:${conf.port} (${conf.transport})`);

  const server: TransportServer =
    conf.transport === "ws"
      ? await listenForHostWs(kp, hostPub, conf.port, onMessage)
      : await listenForHost(kp, hostPub, conf.port, (msg: TpsMessage, channel: TransportChannel) => {
          return onMessage(msg, channel);
        });

  server.onConnection((channel) => {
    activeHostChannel = channel;
    try { flairProxy?.close(); } catch {}
    flairProxy = startFlairProxy(9927, channel);
  });

  const outboxNewDir = join(process.env.HOME || homedir(), ".tps", "outbox", "new");
  mkdirSync(outboxNewDir, { recursive: true });
  const outboxWatcher = watch(outboxNewDir, async () => {
    if (!activeHostChannel || !activeHostChannel.isAlive()) return;
    for (const item of drainOutbox()) {
      await activeHostChannel.send({
        type: MSG_MAIL_DELIVER,
        seq: 0,
        ts: new Date().toISOString(),
        body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
      }).catch(() => {});
    }
  });

  const onShutdown = async () => {
    logLine("STOPPED", "Signal received");
    try { outboxWatcher.close(); } catch {}
    try { flairProxy?.close(); } catch {}
    activeHostChannel = null;
    clearBranchState();
    try { await server.close(); } catch {}
    try { rmSync(pidPath()); } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);

  // Keep alive
  setInterval(() => {}, 60_000);
}

async function runStop(): Promise<void> {
  const p = pidPath();
  if (!existsSync(p)) {
    console.log("Branch daemon is not running.");
    return;
  }
  const pid = Number(readFileSync(p, "utf-8").trim());
  if (!pid || Number.isNaN(pid)) {
    rmSync(p, { force: true });
    console.log("Stale PID file removed.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    rmSync(p, { force: true });
    console.log("Branch daemon not running (stale PID removed).");
    return;
  }

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!processAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(p, { force: true });
  console.log("Branch daemon stopped.");
}

function runStatus(): void {
  const p = pidPath();
  if (!existsSync(p)) {
    console.log("Branch daemon: stopped");
    return;
  }
  const pid = Number(readFileSync(p, "utf-8").trim());
  const alive = pid > 0 && processAlive(pid);
  const confExists = existsSync(confPath());
  const hostExists = existsSync(hostPath(getIdentityDir()));
  console.log(`Branch daemon: ${alive ? "running" : "stopped"}`);
  if (pid) console.log(`PID: ${pid}`);
  if (confExists) {
    const conf = readBranchConf();
    console.log(`Listen: 0.0.0.0:${conf.port}`);
  }
  if (hostExists) {
    const host = JSON.parse(readFileSync(hostPath(getIdentityDir()), "utf-8"));
    console.log(`Host: ${host.hostId} (sha256:${host.fingerprint})`);
  }
}

async function runLog(args: BranchArgs): Promise<void> {
  const p = logPath();
  if (!existsSync(p)) {
    console.log("No branch log yet.");
    return;
  }
  const lines = Number(args.lines ?? 50);
  const text = readFileSync(p, "utf-8");
  const arr = text.split(/\r?\n/).filter(Boolean);
  console.log(arr.slice(-lines).join("\n"));

  if (args.follow) {
    let last = arr.length;
    setInterval(() => {
      const now = readFileSync(p, "utf-8").split(/\r?\n/).filter(Boolean);
      if (now.length > last) {
        console.log(now.slice(last).join("\n"));
        last = now.length;
      }
    }, 500);
  }
}

export async function runBranch(args: BranchArgs): Promise<void> {
  switch (args.action) {
    case "init":
      return runInit(args);
    case "start":
      return runStart();
    case "stop":
      return runStop();
    case "status":
      return runStatus();
    case "log":
      return runLog(args);
    default:
      throw new Error(`Unsupported branch action: ${args.action}`);
  }
}

export function isAlreadyJoined(identityDir: string): boolean {
  return existsSync(join(identityDir, "host.json"));
}

export function buildJoinToken(
  host: string,
  port: number,
  encryptionPubkey: Uint8Array,
  signingPubkey: Uint8Array,
  fp: string,
  transport: "ws" | "tcp" = "ws"
): string {
  const pubkeyB64 = Buffer.from(encryptionPubkey).toString("base64url");
  const sigPubkeyB64 = Buffer.from(signingPubkey).toString("base64url");
  const prefixed = fp.startsWith("sha256:") ? fp : `sha256:${fp}`;
  return `tps://join?host=${encodeURIComponent(host)}&port=${port}&transport=${transport}&pubkey=${pubkeyB64}&sigpubkey=${sigPubkeyB64}&fp=${prefixed}`;
}

export function readHostRecord(identityDir: string): any {
  const p = join(identityDir, "host.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}
