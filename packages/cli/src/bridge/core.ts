/**
 * Bridge Core
 *
 * Adapter-agnostic mail routing. Handles:
 * - Inbound: adapter → validate → write to agent mailbox
 * - Outbound: watch bridge mailbox → adapter.send()
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  watch,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";
import { signOutboundBody } from "../utils/mail-sign.js";

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

export { BRIDGE_ADAPTERS, resolveBridgeAgentId } from "@tpsdev-ai/agent";
import { configureBridgeIdentity } from "@tpsdev-ai/agent";

export interface BridgeCoreConfig {
  bridgeAgentId?: string;
  mailDir?: string;
  defaultAgentId?: string;
  defaultChannelId?: string;
  /** Prompt injected when routing Discord messages. Empty string disables header. */
  discordContextPrompt?: string;
}

export class BridgeCore {
  private readonly bridgeAgentId: string;
  private readonly mailDir: string;
  private readonly defaultAgentId: string;
  private readonly defaultChannelId: string;
  private readonly discordContextPrompt: string;
  private readonly log: (msg: string) => void;
  private stopOutbound: (() => void) | null = null;

  constructor(
    private readonly adapter: BridgeAdapter,
    config: BridgeCoreConfig = {},
    log?: (msg: string) => void,
  ) {
    this.mailDir = config.mailDir ?? process.env.TPS_MAIL_DIR ?? join(process.env.HOME ?? homedir(), ".tps", "mail");
    this.bridgeAgentId = configureBridgeIdentity(this.mailDir, adapter.name, config.bridgeAgentId);
    this.defaultAgentId = config.defaultAgentId ?? "anvil";
    this.defaultChannelId = config.defaultChannelId ?? "";
    this.discordContextPrompt = config.discordContextPrompt ?? "Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.";
    this.log = log ?? ((msg) => console.log(`${new Date().toISOString()} ${msg}`));
  }

  async start(): Promise<void> {
    // Start adapter with inbound callback
    await this.adapter.start((envelope) => this.handleInbound(envelope));

    // Start outbound watcher
    this.stopOutbound = this.watchOutbox();

    // PID file
    const pidDir = join(homedir(), ".tps", "run");
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(
      join(pidDir, `bridge-${this.adapter.name}.pid`),
      JSON.stringify({ pid: process.pid, adapter: this.adapter.name }),
      "utf-8",
    );

    this.log(`[bridge:${this.adapter.name}] Started (agent=${this.bridgeAgentId}, default=${this.defaultAgentId})`);
  }

  async stop(): Promise<void> {
    this.stopOutbound?.();
    await this.adapter.stop();
    const pidPath = join(homedir(), ".tps", "run", `bridge-${this.adapter.name}.pid`);
    rmSync(pidPath, { force: true });
    this.log(`[bridge:${this.adapter.name}] Stopped`);
  }

  private handleInbound(envelope: BridgeEnvelope): string {
    const rawAgentId = envelope.agentId;
    if (rawAgentId !== undefined && !validateAgentId(rawAgentId)) {
      throw new Error(`Invalid agentId: ${rawAgentId}`);
    }

    const targetAgent = rawAgentId ?? this.defaultAgentId;
    const { fresh } = this.mailboxDir(targetAgent);
    mkdirSync(fresh, { recursive: true });

    // cli#433 slice B2-2: the bridge signs every inbound channel message as ITS
    // OWN identity — the existing bridgeAgentId and its own key, never the host
    // agent's — through the same signing path the other producers use. The
    // channel author and content travel as data inside the signed body; the
    // wrapper carries no trust claim. With no bridge key this throws the named
    // missing-key error BEFORE anything is written.
    const body = signOutboundBody(this.bridgeAgentId, targetAgent, this.buildInboundBody(envelope), {
      requireKey: true,
      trust: "external",
      subject: `channel message from ${envelope.channel}`,
      rationale: `bridge ${this.bridgeAgentId} inbound ${envelope.channel}`,
    });

    const id = `${Date.now()}-${randomUUID()}`;
    const msg = {
      id,
      from: this.bridgeAgentId,
      to: targetAgent,
      timestamp: new Date().toISOString(),
      read: false,
      body,
    };

    writeFileSync(join(fresh, `${id}.json`), JSON.stringify(msg, null, 2), "utf-8");
    this.log(`[bridge:inbound] ${envelope.channel}/${envelope.senderId} → ${targetAgent}`);
    return targetAgent;
  }

  private buildInboundBody(envelope: BridgeEnvelope): string {
    if (envelope.metadata?.channel !== "discord") {
      return JSON.stringify(envelope);
    }

    return `[Discord message from ${envelope.senderName}]
Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.

Message: ${envelope.content}`;
  }

  private watchOutbox(): () => void {
    const { fresh, cur } = this.mailboxDir(this.bridgeAgentId);
    mkdirSync(fresh, { recursive: true });
    mkdirSync(cur, { recursive: true });

    const pending = new Set<string>();
    const processFile = async (file: string, recovery = false) => {
      if (!file.endsWith(".json")) return;
      const fullPath = join(recovery ? cur : fresh, file);
      if (!existsSync(fullPath) || pending.has(fullPath)) return;
      pending.add(fullPath);
      try {
        const { promote, recoverPromoted, ackMessage } = await import("../utils/mail.js");
        const result = await (recovery ? recoverPromoted : promote)(this.bridgeAgentId, fullPath);
        if (!result.ok || result.message.trustTier === "external") return;

        let envelope: BridgeEnvelope;
        try {
          const msg = result.message;
          // If body is a JSON-serialized BridgeEnvelope, use it directly.
          // Otherwise treat as plain text and route to the default channel.
          let parsedBody: unknown = null;
          if (typeof msg.body === "string") {
            try { parsedBody = JSON.parse(msg.body); } catch { /* plain text */ }
          }
          if (parsedBody && typeof parsedBody === "object" && "channel" in (parsedBody as object)) {
            envelope = parsedBody as BridgeEnvelope;
          } else {
            // Plain text reply — route back to the channel this agent is bridging
            envelope = {
              channel: this.adapter.name,
              channelId: this.defaultChannelId ?? "",
              content: typeof msg.body === "string" ? msg.body : String(msg.body ?? ""),
              senderId: "agent",
              senderName: "agent",
              timestamp: new Date().toISOString(),
            };
          }
        } catch (e) {
          this.log(`[bridge:outbound] Failed to parse ${file}: ${e}`);
          return;
        }

        await this.adapter.send(envelope).then(() => {
          ackMessage(this.bridgeAgentId, result.message.id);
          this.log(`[bridge:outbound] → ${envelope.channel}/${envelope.channelId}`);
        }).catch((e) => {
          this.log(`[bridge:outbound] Delivery failed: ${e}`);
        });
      } catch (error) {
        this.log(`[bridge:outbound] Deferred ${file}: ${error}`);
      } finally { pending.delete(fullPath); }
    };

    let inflight = Promise.resolve();
    const enqueue = (file: string, recovery = false) => {
      inflight = inflight.then(() => processFile(file, recovery));
    };
    try {
      readdirSync(fresh).filter((f) => f.endsWith(".json")).forEach((file) => { enqueue(file); });
      readdirSync(cur).filter((f) => f.endsWith(".json")).forEach((file) => { enqueue(file, true); });
    } catch {}

    const watcher = watch(fresh, (_event, filename) => {
      if (filename) enqueue(filename.toString());
    });

    return () => { try { watcher.close(); } catch {} };
  }

  private mailboxDir(agentId: string) {
    const base = join(this.mailDir, agentId);
    return { fresh: join(base, "new"), cur: join(base, "cur") };
  }
}
