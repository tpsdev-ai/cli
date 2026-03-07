/**
 * tps bridge — Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon (--adapter openclaw|discord|stdio)
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { bridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { BridgeCore } from "../bridge/core.js";
import { DiscordAdapter } from "../bridge/discord-adapter.js";
import { StdioAdapter } from "../bridge/stdio-adapter.js";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeArgs {
  action: "start" | "stop" | "status";
  adapter?: "openclaw" | "discord" | "stdio";
  // OpenClaw adapter options
  port?: number;
  openClawUrl?: string;
  // Discord adapter options
  discordToken?: string;
  discordTokenFile?: string;
  discordChannel?: string;
  discordPollMs?: number;
  discordContextPrompt?: string;
  botUserId?: string;
  requireMention?: boolean;
  verbose?: boolean;
  // Shared
  bridgeAgentId?: string;
  defaultAgentId?: string;
  mailDir?: string;
  json?: boolean;
}

export async function runBridge(args: BridgeArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      const adapter = args.adapter ?? "openclaw";

      // Discord adapter path — does not use the legacy daemon
      if (adapter === "discord") {
        let token = args.discordToken ?? process.env.DISCORD_BOT_TOKEN;
        if (!token && args.discordTokenFile) {
          const { readFileSync } = await import("node:fs");
          token = readFileSync(args.discordTokenFile, "utf-8").trim();
        }
        const channelId = args.discordChannel ?? process.env.DISCORD_CHANNEL_ID;
        if (!token || !channelId) {
          console.error("Discord bridge requires --discord-token and --discord-channel (or env DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID)");
          process.exit(1);
        }
        const discordAdapter = new DiscordAdapter({
          token,
          channelId,
          pollIntervalMs: args.discordPollMs,
        botUserId: args.botUserId,
        requireMention: args.requireMention,
        verbose: args.verbose,
        });
        const core = new BridgeCore(discordAdapter, {
          bridgeAgentId: args.bridgeAgentId ?? "discord-bridge",
          mailDir: args.mailDir,
          defaultAgentId: args.defaultAgentId ?? "ember",
          defaultChannelId: channelId,
          discordContextPrompt: args.discordContextPrompt,
        });
        await core.start();

        const shutdown = () => { void core.stop().then(() => process.exit(0)); };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        return;
      }

      if (adapter === "stdio") {
        const stdioAdapter = new StdioAdapter();
        const core = new BridgeCore(stdioAdapter, {
          bridgeAgentId: args.bridgeAgentId ?? "stdio-bridge",
          mailDir: args.mailDir,
          defaultAgentId: args.defaultAgentId,
        });
        await core.start();
        const shutdown = () => { void core.stop().then(() => process.exit(0)); };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        return;
      }

      // Default: OpenClaw adapter (legacy path)
      const st = bridgeStatus();
      if (st.running) {
        console.log(`Bridge already running (pid ${st.pid}, port ${st.port})`);
        process.exit(0);
      }
      startBridgeDaemon({
        port: args.port,
        openClawUrl: args.openClawUrl,
        bridgeAgentId: args.bridgeAgentId,
        defaultAgentId: args.defaultAgentId,
        mailDir: args.mailDir,
      });
      break;
    }

    case "stop": {
      const st = bridgeStatus();
      if (!st.running) {
        console.log("Bridge is not running.");
        break;
      }
      try {
        process.kill(st.pid!, "SIGTERM");
        const pidDir = join(homedir(), ".tps", "run");
        rmSync(join(pidDir, "bridge-openclaw.pid"), { force: true });
        rmSync(join(pidDir, "mail-bridge.pid"), { force: true });
        console.log(`Bridge (pid ${st.pid}) stopped.`);
      } catch {
        console.log("Bridge was not running (stale pid cleaned up).");
      }
      break;
    }

    case "status": {
      const st = bridgeStatus();
      if (args.json) {
        console.log(JSON.stringify(st));
      } else if (st.running) {
        console.log(`Bridge running: pid=${st.pid}, port=${st.port}`);
      } else {
        console.log("Bridge is not running.");
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown bridge action: ${_}`);
      process.exit(1);
    }
  }
}
