/**
 * Discord Bridge Adapter
 *
 * Connects TPS mail to a Discord channel via bot token.
 * Agents receive Discord messages as TPS mail; replies route back to Discord.
 *
 * Usage:
 *   tps bridge start --adapter discord --token <BOT_TOKEN> --channel <CHANNEL_ID> --agent ember
 */

import { randomUUID as _randomUUID } from "node:crypto";
import snooplogg from "snooplogg";
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";

const { log: slog, warn: swarn } = snooplogg("bridge:discord");

export function classifyMessage(content: string): "task" | "chat" {
  const taskPatterns = [
    /\b(implement|fix|add|create|build|test|update|remove|refactor|write|deploy|merge|revert|ship)\b/i,
    /\b(packages\/|src\/|test\/|\.ts|\.js|\.md)\b/,
    /\b(PR|pull request|branch|commit|push)\s*#?\d*/i,
    /\bops-\d+/i,
  ];

  return taskPatterns.some((pattern) => pattern.test(content)) ? "task" : "chat";
}

export interface DiscordAdapterConfig {
  /** Discord bot token */
  token: string;
  /** Target channel ID to monitor and post to */
  channelId: string;
  /** Optional pre-created webhook URL for outbound messages only */
  webhookUrl?: string;
  /** Poll interval for incoming messages (ms, default 5000) */
  pollIntervalMs?: number;
  /** Bot's own Discord user ID — used for mention detection */
  botUserId?: string;
  /** If true (default), only forward messages that @mention the bot. Set false to forward all messages. */
  requireMention?: boolean;
}

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordAdapter implements BridgeAdapter {
  readonly name = "discord";

  private token: string;
  private channelId: string;
  private webhookUrl?: string;
  private pollIntervalMs: number;
  private botUserId?: string;
  private requireMention = true;
  private lastMessageId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onInbound: ((envelope: BridgeEnvelope) => string) | null = null;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.channelId = config.channelId;
    this.webhookUrl = config.webhookUrl;
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.botUserId = config.botUserId;
    this.requireMention = config.requireMention !== false;
  }

  async start(onInbound: (envelope: BridgeEnvelope) => string): Promise<void> {
    this.onInbound = onInbound;

    // Seed: set cursor to 5 minutes ago and replay any messages in that window.
    // This catches messages sent just before the bridge started without full history replay.
    const lookbackMs = 5 * 60 * 1000;
    const epoch = BigInt(Date.now() - lookbackMs - 1420070400000) * BigInt(2 ** 22);
    this.lastMessageId = epoch.toString();
    // Replay the lookback window immediately on start
    await this.poll();

    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    console.log(`[discord-bridge] Listening on channel ${this.channelId}`);
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    const isWebhook = Boolean(this.webhookUrl);
    const body = JSON.stringify(
      this.webhookUrl
        ? {
            content: envelope.content,
            username: envelope.senderName || undefined,
          }
        : { content: envelope.content },
    );
    const res = await fetch(
      this.webhookUrl ?? `${DISCORD_API}/channels/${this.channelId}/messages`,
      {
        method: "POST",
        headers: this.webhookUrl ? { "Content-Type": "application/json" } : this.headers(),
        body,
      },
    );
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`${isWebhook ? "Discord webhook send" : "Discord send"} failed (${res.status}): ${err}`);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[discord-bridge] Stopped.");
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bot ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async fetchMessages(limit = 10): Promise<any[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (this.lastMessageId) params.set("after", this.lastMessageId);

    const res = await fetch(
      `${DISCORD_API}/channels/${this.channelId}/messages?${params}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      console.warn(`[discord-bridge] Fetch failed (${res.status})`);
      return [];
    }
    const msgs: any[] = await res.json();
    // Discord returns newest-first; reverse for chronological order
    return msgs.reverse();
  }

  private async poll(): Promise<void> {
    try {
      const messages = await this.fetchMessages();
      if (messages.length > 0) slog(`poll: ${messages.length} message(s)`);
      for (const msg of messages) {
        // Skip bot messages to avoid loops
        if (msg.author?.bot) {
          slog(`skip bot: ${msg.id}`);
          this.lastMessageId = msg.id;
          continue;
        }

        // Mention filtering: skip messages that don't @mention the bot (default: on)
        if (this.requireMention) {
          const mentions = msg.mentions ?? [];
          const mentioned = mentions.some((u: { id: string } | string) => typeof u === "string" ? u === this.botUserId : u.id === this.botUserId);
          if (!mentioned) {
            slog(`skip (no mention): ${msg.id} by ${msg.author?.username}`);
            this.lastMessageId = msg.id;
            continue;
          }
        }

        // Parse @agentname routing (e.g. "@ember do this task")
        const mentionMatch = msg.content.match(/^@([a-zA-Z0-9_-]+)\s*/);
        const agentId = mentionMatch ? mentionMatch[1] : undefined;
        const content = mentionMatch ? msg.content.slice(mentionMatch[0].length).trim() : msg.content;

        const envelope: BridgeEnvelope = {
          channel: "discord",
          channelId: this.channelId,
          senderId: msg.author.id,
          senderName: msg.author.username,
          content,
          agentId,
          timestamp: msg.timestamp,
          replyTo: msg.id,
          metadata: { discordMessageId: msg.id, guildId: msg.guild_id },
        };

        if (this.onInbound) {
          this.onInbound(envelope);
        }

        this.lastMessageId = msg.id;
      }
    } catch (e) {
      const err = e as Error;
      swarn(`poll error: ${err.message}`);
      swarn(err.stack ?? err.message);
    }
  }
}
