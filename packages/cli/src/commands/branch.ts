import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, watch, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { pidState, pidStateFromProbeError, processStartToken, type PidState } from "@tpsdev-ai/agent";
import { generateKeyPair, loadKeyPair, saveKeyPair } from "../utils/identity.js";
import { listenForHost, listenForJoin } from "../utils/noise-ik-transport.js";
import { listenForHostWs, listenForJoinWs } from "../utils/ws-noise-transport.js";
import { MailDeliverBodySchema, MSG_MAIL_DELIVER, MSG_MAIL_ACK, MSG_HEARTBEAT, MSG_JOIN_COMPLETE, JoinCompleteBodySchema, MailAckBodySchema } from "../utils/wire-mail.js";
import { startServiceProxies, type ServiceProxySet } from "../utils/service-proxy-branch.js";
import { sendMessage, inboxExists, findRelayedRecord } from "../utils/mail.js";
import { signForDelivery } from "../utils/mail-producer.js";
import { requireLocalAgentId } from "../utils/local-agent.js";
import { OutboxSendTracker, queueOutboxMessage } from "../utils/outbox.js";
import { clearBranchState, writeBranchState } from "../utils/connection-state.js";
import { discoverManifests } from "../utils/manifest.js";
import { runHandlerPipeline, type HandlerAction } from "../utils/mail-handler.js";
import type { TransportChannel, TpsMessage, TransportServer } from "../utils/transport.js";
import { readPidFile, removePidFile, serializePidRecord, type PidFileState } from "../utils/pid-file.js";
import { acquireMailLockSync, mailLockPath } from "../utils/mail-lock.js";

let activeHostChannel: TransportChannel | null = null;

export interface HandlerIncoming {
  id: string;
  from: string;
  to: string;
  /** Incoming content after transport schema validation. */
  body: string;
}

export type HandlerRoute =
  | { kind: "reply"; to: string }
  | { kind: "forward"; to: string }
  | { kind: "drop" }
  | { kind: "inbox" }
  | { kind: "refused"; reason: string };

/**
 * Resolve the branch's configured local agent id, refusing by name when none is
 * set (cli#499). `TPS_AGENT_ID` wins; otherwise the id persisted by
 * `tps branch init --agent`. There is no fallback to the hostname.
 */
export function branchAgentId(confAgentId?: string): string {
  return requireLocalAgentId("branch agent id", process.env.TPS_AGENT_ID ?? confAgentId);
}

/**
 * Route a handler action for a received message.
 */
export function routeHandlerAction(
  action: HandlerAction,
  incoming: HandlerIncoming,
  queueOutbox: (to: string, body: string, from: string) => void = queueOutboxMessage,
  localAgentId = requireLocalAgentId("branch agent id"),
): HandlerRoute {
  const from = inboxExists(incoming.to) ? incoming.to : localAgentId;
  switch (action.type) {
    case "reply": {
      const to = action.to ?? incoming.from;
      try {
        signForDelivery(from, to, action.body ?? "", (signed) => queueOutbox(to, signed, from));
        return { kind: "reply", to };
      } catch (e: any) {
        return { kind: "refused", reason: e?.message || "signing failed" };
      }
    }
    case "forward": {
      if (!action.to) return { kind: "forward", to: "" };
      try {
        signForDelivery(from, action.to, action.body ?? incoming.body,
          (signed) => queueOutbox(action.to!, signed, from));
        return { kind: "forward", to: action.to };
      } catch (e: any) {
        return { kind: "refused", reason: e?.message || "signing failed" };
      }
    }
    case "drop":
      return { kind: "drop" };
    default:
      return { kind: "inbox" };
  }
}

export interface BranchArgs {
  action: "init" | "start" | "stop" | "status" | "log";
  port?: number;
  host?: string;
  transport?: "ws" | "tcp";
  agent?: string;
  force?: boolean;
  lines?: number;
  follow?: boolean;
}

function tpsRoot(): string {
  return process.env.TPS_ROOT || join(process.env.HOME || homedir(), ".tps");
}

function getIdentityDir(): string {
  return process.env.TPS_IDENTITY_DIR || join(tpsRoot(), "identity");
}

/** Path of the branch daemon pid file, under `TPS_ROOT` when it is set. */
export function pidPath(): string {
  return join(tpsRoot(), "branch.pid");
}

function logPath(): string {
  return join(tpsRoot(), "branch.log");
}

function confPath(): string {
  return join(tpsRoot(), "branch.conf.json");
}

function branchPidRefusal(pid: number, path: string): string {
  return `Branch pid file ${path} names pid ${pid}, but that process's identity cannot be verified. Check that pid and stop it yourself, or remove ${path} if the branch daemon is not running.`;
}

/** Refuse to spawn when the pid record is running, unverified, unreadable or invalid. */
function refuseSecondBranchStart(): void {
  const state = readPidFile(pidPath());
  switch (state.kind) {
    case "running":
      throw new Error(
        `Recorded process (pid ${state.pid}, start token matches) is still running; refusing to spawn (pid file ${state.path}). If pid ${state.pid} is the branch daemon, stop it with "tps branch stop"; otherwise remove ${state.path} only after confirming no branch daemon is running.`,
      );
    case "unverified":
      throw new Error(branchPidRefusal(state.pid, state.path));
    case "unreadable":
      throw new Error(
        `Branch pid file ${state.path} could not be read (${state.reason ?? "read failed"}); refusing to spawn. Make it readable, or remove it if no branch daemon is running.`,
      );
    case "invalid":
      throw new Error(
        `Branch pid file ${state.path} is invalid (${state.reason}); refusing to spawn. Remove it if no branch daemon is running.`,
      );
    case "stale":
    case "missing":
      return;
  }
}

const BRANCH_PID_LOCK_TIMEOUT_MS = 5000;
const BRANCH_TEST_PAUSE_TIMEOUT_MS = 15_000;

/** Root of the inter-process lock that owns the branch pid record. */
export function branchPidLockRoot(path: string = pidPath()): string {
  return `${path}.lock`;
}

/**
 * Hold the branch pid record lock across a synchronous critical section.
 * `acquireMailLockSync` refuses nested acquisition and reclaims a dead owner;
 * a timeout is a refusal, never a proceed.
 */
function withBranchPidLock<T>(path: string, action: string, fn: () => T): T {
  const lockDir = mailLockPath(branchPidLockRoot(path));
  const lock = acquireMailLockSync(branchPidLockRoot(path), { timeoutMs: BRANCH_PID_LOCK_TIMEOUT_MS });
  if (lock === null) {
    throw new Error(
      `Branch pid record lock ${lockDir} could not be acquired within ${BRANCH_PID_LOCK_TIMEOUT_MS} ms; refusing to ${action}. Confirm no branch launcher or daemon is running, then remove ${lockDir} and retry.`,
    );
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Test seam: announce this process for `phase` and wait, bounded, for the
 * phase's `go` file. Set TPS_BRANCH_TEST_PAUSE_DIR to enable; set
 * TPS_BRANCH_TEST_PAUSE_PHASE to pause at one phase only.
 */
function branchTestPause(phase: string, path: string): void {
  const dir = process.env.TPS_BRANCH_TEST_PAUSE_DIR;
  if (dir === undefined) return;
  const wanted = process.env.TPS_BRANCH_TEST_PAUSE_PHASE;
  if (wanted !== undefined && wanted !== phase) return;
  writeFileSync(join(dir, `ready-${phase}-${process.pid}`), path, "utf-8");
  const go = join(dir, `go-${phase}`);
  const deadline = Date.now() + BRANCH_TEST_PAUSE_TIMEOUT_MS;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(go)) {
    if (Date.now() >= deadline) {
      throw new Error(`branch test pause ${phase} timed out waiting for ${go}`);
    }
    Atomics.wait(wait, 0, 0, 5);
  }
}

interface PidRecordSnapshot {
  state: PidFileState;
  raw: string | null;
}

function snapshotPidRecord(path: string): PidRecordSnapshot {
  let raw: string | null = null;
  const state = readPidFile(path, processStartToken, (text) => {
    raw = text;
  });
  return { state, raw };
}

/** Spawn the branch daemon with its pid record claimed under the branch lock. */
function spawnBranchDaemon(): number {
  const path = pidPath();
  mkdirSync(tpsRoot(), { recursive: true });
  return withBranchPidLock(path, "spawn a branch daemon", () => {
    refuseSecondBranchStart();
    branchTestPause("launch-before-spawn", path);
    const outFd = openSync(logPath(), "a");
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [process.argv[1]!, "branch", "start"], {
        detached: true,
        stdio: ["ignore", outFd, outFd],
        env: { ...process.env, TPS_BRANCH_DAEMON: "1" },
      });
      child.unref();
      if (!child.pid) throw new Error("Failed to spawn branch daemon");
      writeFileSync(path, serializePidRecord(child.pid, processStartToken(child.pid)), "utf-8");
      return child.pid;
    } catch (error) {
      const pid = child?.pid;
      if (pid !== undefined) {
        try { process.kill(pid, "SIGTERM"); } catch { /* best effort */ }
      }
      throw error;
    } finally {
      try { closeSync(outFd); } catch {}
    }
  });
}

type PidRecordRemoval =
  | "removed"
  | "missing"
  | "foreign"
  | "unverified"
  | "other"
  | "changed";

/** Remove the record only when the last read under the lock still names this
 *  process with its own start token. */
function removeOwnBranchPidRecord(path: string): PidRecordRemoval {
  const ownToken = processStartToken(process.pid);
  return withBranchPidLock(path, "remove the branch pid record", () => {
    const before = snapshotPidRecord(path);
    branchTestPause("shutdown-before-unlink", path);
    const current = snapshotPidRecord(path);
    if (current.raw !== before.raw) return "changed";
    const state = current.state;
    if (state.kind === "missing") return "missing";
    if (state.kind === "running" && state.pid === process.pid && state.startToken === ownToken) {
      removePidFile(path);
      return "removed";
    }
    if (state.kind === "running") return "foreign";
    if (state.kind === "unverified") return "unverified";
    return "other";
  });
}

function hostPath(identityDir: string): string {
  return join(identityDir, "host.json");
}

function logLine(event: string, msg: string): void {
  appendFileSync(logPath(), `[${new Date().toISOString()}] ${event}: ${msg}\n`, "utf-8");
}

/**
 * Map a raw sendMessage error to a sanitized category safe to send on-wire.
 * Raw errors can include filesystem paths or internal state (Sherlock #294);
 * the host only needs to know the category to surface a useful failure.
 */
function sanitizeDeliveryError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("inbox full")) return "inbox-full";
  if (r.includes("eacces") || r.includes("eperm") || r.includes("permission denied")) return "permission-denied";
  if (r.includes("enospc") || r.includes("no space")) return "disk-full";
  if (r.includes("enoent") || r.includes("no such")) return "path-missing";
  if (r.includes("invalid")) return "invalid-input";
  return "write-failed";
}

export function processAlive(pid: number, probe: (pid: number) => PidState = pidState): boolean {
  return probe(pid) === "alive";
}

/** True when `kill(pid, 0)` was refused with an error pidState calls alive.
 * EPERM establishes that the process exists; an unrecognized error leaves its
 * exit unconfirmed and is treated as alive. */
function pidProbeRefused(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return pidStateFromProbeError(error) === "alive";
  }
}

export function writeBranchConf(port: number, host: string, transport: "ws" | "tcp", agentsDir?: string, agentId?: string): void {
  writeFileSync(
    confPath(),
    JSON.stringify(
      {
        port,
        host,
        transport,
        agentsDir,
        agentId,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );
}

function readBranchConf(): { port: number; host: string; transport: "ws" | "tcp"; agentsDir?: string; agentId?: string } {
  const p = confPath();
  if (!existsSync(p)) throw new Error("branch.conf.json not found. Run `tps branch init` first.");
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const t = raw.transport === "tcp" ? "tcp" : "ws";
  return {
    port: Number(raw.port),
    host: String(raw.host || ""),
    transport: t,
    agentsDir: raw.agentsDir ? String(raw.agentsDir) : undefined,
    agentId: raw.agentId ? String(raw.agentId) : undefined
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

  // Guard against silently overwriting a live branch config.
  // A stale or test-generated config can disrupt running daemons.
  if (existsSync(confPath()) && !args.force) {
    console.error("branch.conf.json already exists. Use --force to reinitialize.");
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
  // Persist --agent; start requires TPS_AGENT_ID or the persisted agentId.
  writeBranchConf(port, advertiseHost, transport, undefined, args.agent);

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
  const daemonPid = spawnBranchDaemon();

  console.log(`Branch daemon running (pid ${daemonPid}). Listening on 0.0.0.0:${port}.`);
  console.log(`Log: ${logPath()}`);
}

async function runStart(): Promise<void> {
  const conf = existsSync(confPath()) ? readBranchConf() : undefined;
  const localAgentId = branchAgentId(conf?.agentId);
  if (!conf) throw new Error("branch.conf.json not found. Run `tps branch init` first.");

  if (
    process.env.TPS_BRANCH_DAEMON !== "1" &&
    process.env.TPS_BRANCH_NO_DAEMON !== "1" &&
    process.env.NODE_ENV !== "test"
  ) {
    const daemonPid = spawnBranchDaemon();
    console.log(`Branch daemon started (pid ${daemonPid}). Log: ${logPath()}`);
    process.exit(0);
  }

  const identityDir = getIdentityDir();
  const hostFile = hostPath(identityDir);
  if (!existsSync(hostFile)) {
    throw new Error("Branch is not joined. Run `tps branch init` first.");
  }

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

  let serviceProxies: ServiceProxySet | null = null;
  const outboxSends = new OutboxSendTracker();

  const onMessage = async (msg: TpsMessage, channel: TransportChannel) => {
    if (activeHostChannel !== channel) {
      if (activeHostChannel) {
        try { activeHostChannel.close?.(); } catch {}
      }
      activeHostChannel = channel;
    }

    writeBranchState({ connectedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), messagesReceived: 0, messagesPushed: 0 });

    if (msg.type === MSG_HEARTBEAT) {
      // Echo heartbeat back so host can track bidirectional liveness
      await channel.send({ type: MSG_HEARTBEAT, seq: msg.seq, ts: new Date().toISOString(), body: {} }).catch(() => {});
      for (const item of outboxSends.due()) {
        await channel.send({
          type: MSG_MAIL_DELIVER,
          seq: msg.seq + 1,
          ts: new Date().toISOString(),
          body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
        }).catch(() => outboxSends.sendFailed(item.id));
      }
      logLine("SYNC", "Heartbeat received — drained outbox");
      return;
    }

    // OPS-122: host advertises services on join — start local proxies
    if (msg.type === MSG_JOIN_COMPLETE) {
      const parsed = JoinCompleteBodySchema.safeParse(msg.body);
      const services = parsed.success ? (parsed.data.services ?? []) : [];
      if (services.length > 0) {
        try { serviceProxies?.close(); } catch {}
        serviceProxies = startServiceProxies(services, channel);
        for (const h of serviceProxies.handles) {
          logLine("PROXY", `Service '${h.name}' proxied on 127.0.0.1:${h.port}`);
        }
      }
      return;
    }

    if (msg.type === MSG_MAIL_ACK) {
      const ack = MailAckBodySchema.safeParse(msg.body);
      if (ack.success && ack.data.accepted) outboxSends.acknowledge(ack.data.id);
      return;
    }
    if (msg.type !== MSG_MAIL_DELIVER) return;
    const parsed = MailDeliverBodySchema.safeParse(msg.body);
    if (!parsed.success) {
      logLine("WARN", "Invalid MAIL_DELIVER payload");
      return;
    }
    const body = parsed.data;

    // Track delivery failure so the ACK reflects actual write success/failure.
    // Without this, an "Inbox full" or similar write error would silently turn
    // into accepted=true and the host's deliverToRemoteBranch would log
    // "Mail delivered" while the message was actually dropped.
    let deliveryError: string | null = null;
    let refused = false;

    const action = await runHandlerPipeline(
      { id: body.id, from: body.from, to: body.to, body: body.content, timestamp: body.timestamp },
      manifests,
      getRegisteredAgents(),
    );

    const routed = routeHandlerAction(action, { id: body.id, from: body.from, to: body.to, body: body.content }, undefined, localAgentId);

    switch (routed.kind) {
      case "reply":
        logLine("HANDLER", `Reply queued to ${routed.to}`);
        break;
      case "forward":
        if (routed.to) logLine("HANDLER", `Forwarded to ${routed.to}`);
        break;
      case "refused":
        logLine("WARN", `Handler action refused: ${routed.reason}`);
        deliveryError = sanitizeDeliveryError(routed.reason);
        break;
      case "drop":
        logLine("HANDLER", `Message ${body.id} dropped`);
        break;
      case "inbox":
      default: {
        // Route by body.to when the recipient has an inbox on this branch
        // (multi-agent case: tps-anvil hosts both `anvil` and `anvil-2`).
        // Fall back to localAgentId when body.to has no inbox here — that
        // preserves the original behavior for the GAL-alias case where
        // body.to is a logical name that doesn't match any local agent dir.
        const recipient = inboxExists(body.to) ? body.to : localAgentId;
        const delivery = { branchId: channel.peerFingerprint(), id: body.id };
        let recorded: string | undefined;
        let recordError: unknown;
        try {
          recorded = findRelayedRecord(recipient, delivery, {
            from: body.from,
            to: recipient,
            body: body.content,
            timestamp: body.timestamp,
          }, body.to);
        } catch (e) {
          recordError = e;
        }
        if (recordError) {
          logLine("WARN", `Relayed delivery refused: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
          refused = true;
        } else if (!recorded) {
          try {
            sendMessage(recipient, body.content, body.from, delivery, body.timestamp, body.to);
          } catch (e: any) {
            // Honest NACK: an "Inbox full" or other write failure must NOT be
            // ACKed as accepted=true. Silent drops here strand entire dispatches
            // because the host's deliverToRemoteBranch only checks the ACK.
            // Log the raw error locally, but send only a sanitized category
            // to the host (Sherlock #294: raw error messages can include
            // filesystem paths or internal state — leak surface to remote).
            const rawError = e?.message || "Mail write failed";
            logLine("WARN", `Mail write failed: ${rawError}`);
            deliveryError = sanitizeDeliveryError(rawError);
          }
        }
        break;
      }
    }

    if (!refused) {
      const ackAccepted = deliveryError === null;
      await channel.send({
        type: MSG_MAIL_ACK,
        seq: msg.seq,
        ts: new Date().toISOString(),
        body: ackAccepted
          ? { id: body.id, accepted: true }
          : { id: body.id, accepted: false, error: deliveryError },
      }).catch(() => {});
      logLine("MAIL", `Received message for ${body.to} (id: ${body.id})`);
    }

    for (const item of outboxSends.due()) {
      await channel.send({
        type: MSG_MAIL_DELIVER,
        seq: msg.seq + 1,
        ts: new Date().toISOString(),
        body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
      }).catch(() => outboxSends.sendFailed(item.id));
    }
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
    // Close any previous proxies — new connection, new proxies (host will resend MSG_JOIN_COMPLETE)
    try { serviceProxies?.close(); } catch {}
    serviceProxies = null;
  });

  const outboxNewDir = join(process.env.HOME || homedir(), ".tps", "outbox", "new");
  mkdirSync(outboxNewDir, { recursive: true });
  const outboxWatcher = watch(outboxNewDir, async () => {
    if (!activeHostChannel || !activeHostChannel.isAlive()) return;
    for (const item of outboxSends.due()) {
      await activeHostChannel.send({
        type: MSG_MAIL_DELIVER,
        seq: 0,
        ts: new Date().toISOString(),
        body: { id: item.id, from: item.from, to: item.to, content: item.body, timestamp: item.timestamp },
      }).catch(() => outboxSends.sendFailed(item.id));
    }
  });

  const onShutdown = async () => {
    logLine("STOPPED", "Signal received");
    try { outboxWatcher.close(); } catch {}
    try { serviceProxies?.close(); } catch {}
    serviceProxies = null;
    activeHostChannel = null;
    clearBranchState();
    try { await server.close(); } catch {}
    const p = pidPath();
    try {
      const outcome = removeOwnBranchPidRecord(p);
      if (outcome === "missing") {
        logLine("STOPPED", `No pid record at ${p}; nothing was removed.`);
      } else if (outcome === "foreign") {
        logLine("STOPPED", `Pid record ${p} does not match this process's pid and start token; leaving it in place.`);
      } else if (outcome === "unverified") {
        logLine("STOPPED", `Pid record ${p} does not verify as this process; leaving it in place.`);
      } else if (outcome === "changed") {
        logLine("STOPPED", `Pid record ${p} changed while it was being removed; leaving the new record in place.`);
      } else if (outcome === "other") {
        logLine("STOPPED", `Pid record ${p} could not be read as this process's record; leaving it in place.`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      logLine("STOPPED", `Pid record ${p} could not be removed or verified (${code}); leaving it in place.`);
    }
    process.exit(0);
  };

  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);

  // Keep alive — bun does not treat a no-op interval as a ref'd handle, so the
  // event loop drains and the daemon exits ~150ms after listen(). A
  // never-resolving promise holds the loop until SIGTERM/SIGINT calls process.exit.
  await new Promise<void>(() => {});
}

type StopSignal = (pid: number) => void;
let sendStopSignal: StopSignal = (pid) => process.kill(pid, "SIGTERM");

/** Replace the stop signal sender; tests use it to assert an invalid pid is
 * refused before any signal is sent. Returns the previous sender. */
export function setBranchStopSignal(fn: StopSignal): StopSignal {
  const previous = sendStopSignal;
  sendStopSignal = fn;
  return previous;
}

async function runStop(): Promise<void> {
  const p = pidPath();

  // A removal failure keeps the pid file, reports the path and the error code,
  // and exits non-zero.
  const removeBranchPid = (path: string): "removed" | "already gone" => {
    try {
      return removePidFile(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(`Branch pid file ${path} could not be removed (${code}); the pid file was kept.`);
    }
  };
  const refusal = (pid: number, path: string): Error => new Error(branchPidRefusal(pid, path));
  const changed = (path: string): Error =>
    new Error(
      `Branch pid file ${path} changed while "tps branch stop" was in progress; refusing to remove the new record. Re-run "tps branch stop".`,
    );
  const removeAfterRecheck = (path: string, before: PidRecordSnapshot): "removed" | "already gone" => {
    branchTestPause("stop-before-unlink", path);
    const current = snapshotPidRecord(path);
    if (current.raw !== before.raw) throw changed(path);
    return removeBranchPid(path);
  };

  type StopDecision =
    | { kind: "done"; message: string }
    | { kind: "waited"; pid: number; path: string; snapshot: PidRecordSnapshot };

  const decision: StopDecision = withBranchPidLock(p, "stop the branch daemon", () => {
    const opened = snapshotPidRecord(p);
    branchTestPause("stop-before-decision", p);
    const current = snapshotPidRecord(p);
    if (current.raw !== opened.raw) throw changed(p);
    const state = current.state;

    if (state.kind === "missing") {
      return { kind: "done", message: `No branch PID file at ${p}; nothing was signalled.` };
    }
    if (state.kind === "unreadable") {
      throw new Error(
        `Branch pid file ${state.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${state.path} if the branch daemon is not running.`,
      );
    }
    if (state.kind === "invalid") {
      return {
        kind: "done",
        message:
          removeAfterRecheck(state.path, current) === "removed"
            ? `Branch PID file ${state.path} was invalid and was removed; the branch daemon's state is unknown.`
            : `Branch PID file ${state.path} was invalid and is already gone; the branch daemon's state is unknown.`,
      };
    }
    if (state.kind === "stale") {
      return {
        kind: "done",
        message:
          removeAfterRecheck(state.path, current) === "removed"
            ? `Branch PID file ${state.path} was stale and was removed; this command signalled no process.`
            : `Branch PID file ${state.path} was stale and is already gone; this command signalled no process.`,
      };
    }
    if (state.kind === "unverified") {
      throw refusal(state.pid, state.path);
    }

    const pid = state.pid;
    try {
      sendStopSignal(pid);
    } catch (error) {
      // ESRCH from the signal permits removal; other signal errors keep the file.
      if (pidStateFromProbeError(error) !== "gone") {
        throw new Error(`Branch daemon could not be stopped (pid ${pid}); PID file kept at ${state.path}.`);
      }
      return {
        kind: "done",
        message:
          removeAfterRecheck(state.path, current) === "removed"
            ? `Recorded branch process (pid ${pid}) is gone (stale PID file removed).`
            : `Recorded branch process (pid ${pid}) is gone (PID file already gone).`,
      };
    }
    return { kind: "waited", pid, path: state.path, snapshot: current };
  });

  if (decision.kind === "done") {
    console.log(decision.message);
    return;
  }

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!processAlive(decision.pid)) break;
    // A probe refused with EPERM keeps returning "alive"; stop waiting and
    // report rather than polling until the deadline.
    if (pidProbeRefused(decision.pid)) break;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  if (processAlive(decision.pid)) {
    throw new Error(`Branch daemon could not be stopped (pid ${decision.pid}); PID file kept.`);
  }

  const removal = withBranchPidLock(decision.path, "remove the branch pid record", () => {
    const opened = snapshotPidRecord(decision.path);
    branchTestPause("stop-before-unlink", decision.path);
    const current = snapshotPidRecord(decision.path);
    if (current.raw !== opened.raw) throw changed(decision.path);
    if (current.raw !== null && current.raw !== decision.snapshot.raw) throw changed(decision.path);
    return removeBranchPid(decision.path);
  });

  console.log(
    removal === "removed"
      ? `Recorded branch process (pid ${decision.pid}) stopped (PID file removed).`
      : `Recorded branch process (pid ${decision.pid}) stopped (PID file already gone).`,
  );
}

function runStatus(): void {
  const p = pidPath();
  const state = readPidFile(p);
  if (state.kind === "running") {
    console.log("Recorded branch process: running");
    console.log(`PID: ${state.pid}`);
  } else if (state.kind === "unverified") {
    console.log(`Branch daemon: unverified (pid ${state.pid}, pid file ${state.path})`);
  } else if (state.kind === "stale") {
    console.log(`Branch daemon: unknown (stale pid file ${state.path})`);
  } else if (state.kind === "invalid") {
    console.log(`Branch daemon: unknown (invalid pid file ${state.path})`);
  } else if (state.kind === "unreadable") {
    console.log(`Branch daemon: unknown (pid file ${state.path} could not be read)`);
  } else {
    console.log(`Branch daemon: unknown (no pid file at ${p})`);
  }
  const confExists = existsSync(confPath());
  const hostExists = existsSync(hostPath(getIdentityDir()));
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
