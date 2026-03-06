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
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";

export interface DiscordAdapterConfig {
  /** Discord bot token */
  token: string;
  /** Target channel ID to monitor and post to */
  channelId: string;
  /** Poll interval for incoming messages (ms, default 5000) */
  pollIntervalMs?: number;
}

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordAdapter implements BridgeAdapter {
  readonly name = "discord";

  private token: string;
  private channelId: string;
  private pollIntervalMs: number;
  private lastMessageId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onInbound: ((envelope: BridgeEnvelope) => string) | null = null;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.channelId = config.channelId;
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
  }

  async start(onInbound: (envelope: BridgeEnvelope) => string): Promise<void> {
    this.onInbound = onInbound;

    // Seed lastMessageId so we don't replay history on boot
    const recent = await this.fetchMessages(1);
    if (recent.length > 0) {
      this.lastMessageId = recent[0].id;
    }

    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
    console.log(`[discord-bridge] Listening on channel ${this.channelId}`);
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    const body = JSON.stringify({ content: envelope.content });
    const res = await fetch(`${DISCORD_API}/channels/${this.channelId}/messages`, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Discord send failed (${res.status}): ${err}`);
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
      for (const msg of messages) {
        // Skip bot messages to avoid loops
        if (msg.author?.bot) {
          this.lastMessageId = msg.id;
          continue;
        }

        const envelope: BridgeEnvelope = {
          channel: "discord",
          channelId: this.channelId,
          senderId: msg.author.id,
          senderName: msg.author.username,
          content: msg.content,
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
      console.warn(`[discord-bridge] Poll error: ${err.message}`);
    }
  }
}
