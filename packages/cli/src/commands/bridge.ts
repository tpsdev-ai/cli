/**
 * tps bridge — Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon (--adapter openclaw|discord|stdio)
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { requireLocalAgentId } from "../utils/local-agent.js";
import { bridgePidFiles, bridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { BridgeCore } from "../bridge/core.js";
import { DiscordAdapter } from "../bridge/discord-adapter.js";
import { StdioAdapter } from "../bridge/stdio-adapter.js";
import { rmSync } from "node:fs";
import { pidState, pidStateFromProbeError } from "@tpsdev-ai/agent";

/** The signal sender for `bridge stop`; replaceable in tests so they can
 *  assert that an unverifiable pid file sends nothing. */
type BridgeStopSignal = (pid: number) => void;
let sendBridgeStopSignal: BridgeStopSignal = (pid) => process.kill(pid, "SIGTERM");

export function setBridgeStopSignal(fn: BridgeStopSignal): BridgeStopSignal {
  const previous = sendBridgeStopSignal;
  sendBridgeStopSignal = fn;
  return previous;
}

/** True when `kill(pid, 0)` was refused with an error pidState calls alive. */
function bridgeProbeRefused(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return pidStateFromProbeError(error) === "alive";
  }
}

/** Wait for a signalled bridge to exit, with a hard 5 s bound. */
async function waitForBridgeExit(pid: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (pidState(pid) === "gone") return true;
    // A probe refused with EPERM keeps returning "alive"; stop waiting and
    // report rather than polling until the deadline.
    if (bridgeProbeRefused(pid)) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pidState(pid) === "gone";
}

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
  discordWebhookUrl?: string;
  discordPollMs?: number;
  discordContextPrompt?: string;
  botUserId?: string;
  requireMention?: boolean;
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
          webhookUrl: args.discordWebhookUrl,
          pollIntervalMs: args.discordPollMs,
        botUserId: args.botUserId,
        requireMention: args.requireMention,
        });
        const core = new BridgeCore(discordAdapter, {
          bridgeAgentId: args.bridgeAgentId,
          mailDir: args.mailDir,
          defaultAgentId: requireLocalAgentId("bridge default agent id", args.defaultAgentId),
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
          bridgeAgentId: args.bridgeAgentId,
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
      const files = bridgePidFiles();
      if (files.length === 0) {
        console.log("Bridge is not running.");
        break;
      }
      const active = files.find(
        (e) => e.state.kind === "running" || e.state.kind === "unverified" || e.state.kind === "unreadable",
      );
      if (!active) {
        // Only stale or invalid files: remove exactly those and say so once.
        let removed = false;
        for (const entry of files) {
          if (entry.state.kind === "stale" || entry.state.kind === "invalid") {
            rmSync(entry.path, { force: true });
            removed = true;
          }
        }
        console.log(removed ? "Bridge is not running (stale pid file removed)." : "Bridge is not running.");
        break;
      }
      const state = active.state;
      if (state.kind === "unreadable") {
        throw new Error(
          `Bridge pid file ${state.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${state.path} if the bridge is not running.`,
        );
      }
      if (state.kind === "unverified") {
        throw new Error(
          `Bridge pid file names pid ${state.pid}, but that process's identity cannot be verified. Check that pid and stop it yourself, or remove ${state.path} if the bridge is not running.`,
        );
      }
      if (state.kind !== "running") break;
      try {
        sendBridgeStopSignal(state.pid);
      } catch (error) {
        // EPERM means the process exists and this user may not signal it: keep
        // the pid file and fail with the operator's recovery path.
        if (pidStateFromProbeError(error) === "alive") {
          throw new Error(`Bridge could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
        }
        rmSync(state.path, { force: true });
        console.log("Bridge is not running (stale pid file removed).");
        break;
      }
      if (!(await waitForBridgeExit(state.pid))) {
        throw new Error(`Bridge could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
      }
      for (const entry of files) rmSync(entry.path, { force: true });
      console.log(`Bridge (pid ${state.pid}) stopped.`);
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
