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
import { promote, recoverPromoted, redriveRetryable, ackMessageAtPath, setBridgeSentAtPath, type PromoteOk } from "../utils/mail.js";
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
  /** Mailbox retry interval in ms (default 30000). */
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
    this.mailDir = config.mailDir ?? process.env.TPS_MAIL_DIR ?? join(process.env.HOME ?? homedir(), ".tps", "mail");
    this.bridgeAgentId = configureBridgeIdentity(this.mailDir, adapter.name, config.bridgeAgentId);
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

    // cli#433 slice B2-2: the bridge signs every inbound channel message as ITS
    // OWN identity — the existing bridgeAgentId and its own key, never the host
    // agent's — through the shared signing helper `signOutboundBody`. The
    // channel author and content travel as data inside the signed body; the
    // wrapper carries no trust claim. Signing runs FIRST, before the recipient
    // inbox is created: with no bridge key this throws the named missing-key
    // error, and no mail record (and no inbox) is written. (The bridge-principal
    // record is written separately, by the constructor.)
    const body = signOutboundBody(this.bridgeAgentId, targetAgent, this.buildInboundBody(envelope), {
      requireKey: true,
      trust: "external",
      subject: `channel message from ${envelope.channel}`,
      rationale: `bridge ${this.bridgeAgentId} inbound ${envelope.channel}`,
    });

    const { fresh } = this.mailboxDir(targetAgent);
    mkdirSync(fresh, { recursive: true });

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

    return `[Discord message from ${envelope.senderName} (sender ${envelope.senderId}, channel ${envelope.channelId})]
Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.

Message: ${envelope.content}`;
  }

  private watchOutbox(): () => void {
    const { fresh, cur, dlq } = this.mailboxDir(this.bridgeAgentId);
    mkdirSync(fresh, { recursive: true });
    mkdirSync(cur, { recursive: true });

    let stopped = false;
    let work = Promise.resolve();
    const pending = new Set<string>();
    const enqueue = (task: () => Promise<void>) => {
      work = work.then(async () => {
        if (!stopped) await task();
      }).catch((e) => this.log(`[bridge:outbound] mailbox processing failed: ${e}`));
      return work;
    };

    const forward = async (result: PromoteOk) => {
      if (result.message.trustTier === "external") return;
      if (result.message.read || result.message.ackedAt || result.message.bridgeSentAt) return;
      const verifiedBody = result.message.body;
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
      try {
        await this.adapter.send(envelope);
      } catch (e) {
        this.log(`[bridge:outbound] Delivery failed: ${e}`);
        return;
      }
      setBridgeSentAtPath(result.path, new Date().toISOString());
      this.log(`[bridge:outbound] → ${envelope.channel}/${envelope.channelId}`);
      try {
        ackMessageAtPath(result.path);
      } catch (e) {
        this.log(`[bridge:outbound] ack failed for ${result.path} after send: ${e}`);
      }
    };

    const promoteFile = async (file: string, recovery = false) => {
      if (!file.endsWith(".json")) return;
      const fullPath = join(recovery ? cur : fresh, file);
      if (!existsSync(fullPath)) return;
      try {
        const result = await (recovery ? recoverPromoted : promote)(this.bridgeAgentId, fullPath);
        if (!result.ok) {
          this.log(`[bridge:outbound] ${file} not promoted (${result.class}); not forwarded`);
          return;
        }
        await forward(result);
      } catch (e) {
        this.log(`[bridge:outbound] promotion failed for ${file}: ${e}`);
      }
    };

    const processFile = (file: string, recovery = false) => {
      const fullPath = join(recovery ? cur : fresh, file);
      if (!file.endsWith(".json") || pending.has(fullPath) || stopped) return;
      pending.add(fullPath);
      void enqueue(async () => {
        try {
          await promoteFile(file, recovery);
        } finally {
          pending.delete(fullPath);
        }
      });
    };

    let redriving = false;
    const redrive = () => {
      if (redriving || stopped) return;
      redriving = true;
      void enqueue(async () => {
        try {
          for (const file of readdirSync(fresh)) await promoteFile(file);
          for (const promoted of await redriveRetryable(this.bridgeAgentId, dlq)) await forward(promoted);
        } finally {
          redriving = false;
        }
      });
    };

    try {
      for (const f of readdirSync(fresh).filter((name) => name.endsWith(".json"))) processFile(f);
      for (const f of readdirSync(cur).filter((name) => name.endsWith(".json"))) processFile(f, true);
    } catch {}

    const watcher = watch(fresh, (_event, filename) => {
      if (filename) processFile(filename.toString());
    });
    const redriveTimer = setInterval(() => void redrive(), this.redriveMs);

    return () => {
      stopped = true;
      clearInterval(redriveTimer);
      try { watcher.close(); } catch {}
    };
  }

  private mailboxDir(agentId: string) {
    const base = join(this.mailDir, agentId);
    return { fresh: join(base, "new"), cur: join(base, "cur"), dlq: join(base, "dlq") };
  }
}
