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
import { promote, redriveRetryable } from "../utils/mail.js";
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

export interface BridgeCoreConfig {
  bridgeAgentId?: string;
  mailDir?: string;
  defaultAgentId?: string;
  defaultChannelId?: string;
  /** Prompt injected when routing Discord messages. Empty string disables header. */
  discordContextPrompt?: string;
  /** How often retryable dlq/ entries are re-driven, in ms (default 30000). */
  redriveMs?: number;
}

export class BridgeCore {
  private readonly bridgeAgentId: string;
  private readonly mailDir: string;
  private readonly defaultAgentId: string;
  private readonly defaultChannelId: string;
  private readonly discordContextPrompt: string;
  private readonly log: (msg: string) => void;
  private readonly redriveMs: number;
  private stopOutbound: (() => void) | null = null;

  constructor(
    private readonly adapter: BridgeAdapter,
    config: BridgeCoreConfig = {},
    log?: (msg: string) => void,
  ) {
    this.bridgeAgentId = config.bridgeAgentId ?? "bridge-" + adapter.name;
    this.mailDir = config.mailDir ?? join(homedir(), ".tps", "mail");
    this.defaultAgentId = config.defaultAgentId ?? "anvil";
    this.defaultChannelId = config.defaultChannelId ?? "";
    this.discordContextPrompt = config.discordContextPrompt ?? "Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.";
    this.redriveMs = config.redriveMs ?? 30_000;
    this.log = log ??((msg) => console.log(`${new Date().toISOString()} ${msg}`));
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

    const id = `${Date.now()}-${randomUUID()}`;
    const msg = {
      id,
      from: this.bridgeAgentId,
      to: targetAgent,
      timestamp: new Date().toISOString(),
      headers: {
        "X-TPS-Trust": "external",
        "X-TPS-Sender": envelope.senderId,
        "X-TPS-Channel": `${envelope.channel}:${envelope.channelId}`,
      },
      body: this.buildInboundBody(envelope),
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
    const { fresh, dlq } = this.mailboxDir(this.bridgeAgentId);
    mkdirSync(fresh, { recursive: true });

    const processFile = async (file: string) => {
      if (!file.endsWith(".json")) return;
      const fullPath = join(fresh, file);
      if (!existsSync(fullPath)) return;

      // Only a record promote() verified is forwarded (cli#380).
      let promoted: Awaited<ReturnType<typeof promote>>;
      try {
        promoted = await promote(this.bridgeAgentId, fullPath);
      } catch (e) {
        this.log(`[bridge:outbound] promotion failed for ${file}: ${e}`);
        return;
      }
      if (!promoted.ok) {
        this.log(`[bridge:outbound] ${file} not promoted (${promoted.class}); not forwarded`);
        return;
      }
      forward(promoted.message.body);
    };

    // Re-drive retryable dlq/ entries (a verifier outage) on every interval.
    let redriving = false;
    const redrive = async () => {
      if (redriving) return;
      redriving = true;
      try {
        for (const promoted of await redriveRetryable(this.bridgeAgentId, dlq)) forward(promoted.message.body);
      } catch (e) {
        this.log(`[bridge:outbound] dlq re-drive failed: ${e}`);
      } finally {
        redriving = false;
      }
    };

    // The promoted body is the verified payload (the envelope's body).
    const forward = (verifiedBody: string) => {
      let envelope: BridgeEnvelope;
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(verifiedBody);
      } catch {
        /* plain text */
      }
      if (parsedBody && typeof parsedBody === "object" && "channel" in (parsedBody as object)) {
        envelope = parsedBody as BridgeEnvelope;
      } else {
        // Plain text reply — route back to the channel this agent is bridging
        envelope = {
          channel: this.adapter.name,
          channelId: this.defaultChannelId ?? "",
          content: verifiedBody,
          senderId: "agent",
          senderName: "agent",
          timestamp: new Date().toISOString(),
        };
      }

      this.adapter.send(envelope).then(() => {
        this.log(`[bridge:outbound] → ${envelope.channel}/${envelope.channelId}`);
      }).catch((e) => {
        this.log(`[bridge:outbound] Delivery failed: ${e}`);
      });
    };

    try {
      readdirSync(fresh).filter((f) => f.endsWith(".json")).forEach((f) => void processFile(f));
    } catch {}

    const watcher = watch(fresh, (_event, filename) => {
      if (filename) void processFile(filename.toString());
    });
    const redriveTimer = setInterval(() => void redrive(), this.redriveMs);

    return () => {
      clearInterval(redriveTimer);
      try { watcher.close(); } catch {}
    };
  }

  private mailboxDir(agentId: string) {
    const base = join(this.mailDir, agentId);
    return { fresh: join(base, "new"), cur: join(base, "cur"), dlq: join(base, "dlq") };
  }
}
