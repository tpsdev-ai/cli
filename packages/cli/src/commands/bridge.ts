/**
 * tps bridge — Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon (--adapter openclaw|discord|stdio)
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { requireLocalAgentId } from "../utils/local-agent.js";
import { bridgePidFiles, bridgeRunningRecords, bridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { BridgeCore } from "../bridge/core.js";
import { DiscordAdapter } from "../bridge/discord-adapter.js";
import { StdioAdapter } from "../bridge/stdio-adapter.js";
import { readPidFile, removePidFile } from "../utils/pid-file.js";
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

/** Wait for a signalled bridge to exit, polling for up to about 5 s. */
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

      // Default: OpenClaw adapter (legacy path). Only the OpenClaw records
      // (bridge-openclaw.pid and the legacy mail-bridge.pid) can refuse it.
      const st = bridgeStatus(pidState, "openclaw");
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
      // Classify every record up front for planning and reporting, then handle
      // each one independently: one failure must not skip a later record.
      const failures: string[] = [];
      const stopped = new Set<number>();
      // A removal failure keeps that file, reports the path and the error code,
      // and leaves the remaining records to run.
      const remove = (path: string): "removed" | "already gone" | "kept" => {
        try {
          return removePidFile(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "unknown";
          failures.push(`Bridge pid file ${path} could not be removed (${code}); the pid file was kept.`);
          return "kept";
        }
      };
      for (const entry of files) {
        const state = entry.state;
        if (state.kind === "missing") continue;
        if (state.kind === "unreadable") {
          failures.push(
            `Bridge pid file ${state.path} could not be read, so its process identity cannot be verified; the pid file was kept. Check that process and stop it yourself, or remove ${state.path} if the bridge is not running.`,
          );
          continue;
        }
        if (state.kind === "unverified") {
          failures.push(
            `Bridge pid file ${state.path} names pid ${state.pid}, but that process's identity cannot be verified; the pid file was kept. Check that pid and stop it yourself, or remove ${state.path} if the bridge is not running.`,
          );
          continue;
        }
        if (state.kind === "stale" || state.kind === "invalid") {
          const removal = remove(state.path);
          if (removal === "removed") {
            console.log(`${state.kind === "stale" ? "Stale" : "Invalid"} pid file removed: ${state.path}.`);
          } else if (removal === "already gone") {
            console.log(`Pid file already gone: ${state.path}.`);
          }
          continue;
        }
        // The up-front classification is the plan, not the decision: re-read
        // this file immediately before acting on it and signal only the same
        // pid with the same token.
        const fresh = readPidFile(state.path);
        if (fresh.kind !== "running" || fresh.pid !== state.pid || fresh.startToken !== state.startToken) {
          if (fresh.kind === "missing") {
            console.log(`Pid file already gone: ${state.path}.`);
          } else if (fresh.kind === "stale" || fresh.kind === "invalid") {
            const removal = remove(fresh.path);
            if (removal === "removed") {
              console.log(`${fresh.kind === "stale" ? "Stale" : "Invalid"} pid file removed: ${fresh.path}.`);
            } else if (removal === "already gone") {
              console.log(`Pid file already gone: ${fresh.path}.`);
            }
          } else if (fresh.kind === "unreadable") {
            failures.push(
              `Bridge pid file ${fresh.path} could not be read, so its process identity cannot be verified; the pid file was kept. Check that process and stop it yourself, or remove ${fresh.path} if the bridge is not running.`,
            );
          } else if (fresh.kind === "unverified") {
            failures.push(
              `Bridge pid file ${fresh.path} names pid ${fresh.pid}, but that process's identity cannot be verified; the pid file was kept. Check that pid and stop it yourself, or remove ${fresh.path} if the bridge is not running.`,
            );
          } else if (fresh.pid !== state.pid) {
            failures.push(
              `Bridge pid file ${fresh.path} now names pid ${fresh.pid}, which is not the planned pid ${state.pid}; it was not signalled and the pid file was kept.`,
            );
          } else {
            failures.push(
              `Bridge pid file ${fresh.path} still names pid ${fresh.pid}, but the process identity changed since it was planned; it was not signalled and the pid file was kept.`,
            );
          }
          continue;
        }
        if (stopped.has(state.pid)) {
          // The same process was already stopped through another record.
          if (pidState(state.pid) !== "gone") {
            failures.push(
              `Bridge pid file ${state.path} names pid ${state.pid}, which is no longer proven gone; the pid file was kept.`,
            );
            continue;
          }
          const removal = remove(state.path);
          if (removal === "removed") {
            console.log(`Pid file removed: ${state.path}.`);
          } else if (removal === "already gone") {
            console.log(`Pid file already gone: ${state.path}.`);
          }
          continue;
        }
        try {
          sendBridgeStopSignal(state.pid);
        } catch (error) {
          // Only a probe that classifies the pid "gone" proves the process is
          // gone: remove the file in that case. EPERM ("alive") and any other
          // result keep the file and report it.
          if (pidStateFromProbeError(error) !== "gone") {
            failures.push(`Bridge could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
            continue;
          }
          const removal = remove(state.path);
          if (removal === "removed") {
            console.log(`Stale pid file removed: ${state.path}.`);
          } else if (removal === "already gone") {
            console.log(`Pid file already gone: ${state.path}.`);
          }
          continue;
        }
        if (!(await waitForBridgeExit(state.pid))) {
          failures.push(`Bridge could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
          continue;
        }
        stopped.add(state.pid);
        const removal = remove(state.path);
        if (removal === "removed") {
          console.log(`Bridge (pid ${state.pid}) stopped; pid file removed: ${state.path}.`);
        } else if (removal === "already gone") {
          console.log(`Bridge (pid ${state.pid}) stopped; pid file already gone: ${state.path}.`);
        }
      }
      if (failures.length > 0) {
        // Print every outcome; the aggregate error makes the command exit
        // non-zero after all records have been handled.
        for (const line of failures) console.error(line);
        throw new Error(failures.join(" "));
      }
      break;
    }

    case "status": {
      const running = bridgeRunningRecords();
      if (args.json) {
        const [first] = running;
        const status = first
          ? { running: true, pid: first.pid, ...(first.port === undefined ? {} : { port: first.port }), adapter: first.adapter, bridges: running }
          : { running: false };
        console.log(JSON.stringify(status));
      } else if (running.length > 0) {
        for (const entry of running) {
          console.log(`Bridge running: adapter=${entry.adapter}, pid=${entry.pid}, port=${entry.port}`);
        }
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
