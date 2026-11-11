/**
 * tps bridge — Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon (--adapter openclaw|discord|stdio)
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { requireLocalAgentId } from "../utils/local-agent.js";
import { bridgePidFiles, bridgeStatusSnapshot, openClawBridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { BridgeCore } from "../bridge/core.js";
import { DiscordAdapter } from "../bridge/discord-adapter.js";
import { StdioAdapter } from "../bridge/stdio-adapter.js";
import { removePidFile, pidRecordBytesEqual, snapshotPidRecord, type PidFileState, type PidRecordSnapshot } from "../utils/pid-file.js";
import { pidState, pidStateFromProbeError, processIsGone } from "@tpsdev-ai/agent";

/** The signal sender for `bridge stop`; replaceable in tests so they can
 *  assert that an unverifiable pid file sends nothing. */
type BridgeStopSignal = (pid: number) => void;
let sendBridgeStopSignal: BridgeStopSignal = (pid) => process.kill(pid, "SIGTERM");

export function setBridgeStopSignal(fn: BridgeStopSignal): BridgeStopSignal {
  const previous = sendBridgeStopSignal;
  sendBridgeStopSignal = fn;
  return previous;
}

/** The pid-record reader for `bridge stop`'s pre-signal re-read; replaceable in
 *  tests so a record can change between the up-front classification and the
 *  re-read. It carries the raw bytes the state was classified from, so every
 *  removal can compare them before unlinking. */
type BridgeStopRecordReader = (path: string) => PidRecordSnapshot;
let bridgeStopRecordReader: BridgeStopRecordReader | null = null;

export function setBridgeStopRecordReader(fn: BridgeStopRecordReader | null): BridgeStopRecordReader | null {
  const previous = bridgeStopRecordReader;
  bridgeStopRecordReader = fn;
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
      // (bridge-openclaw.pid and the legacy mail-bridge.pid) can refuse it, and
      // they are read by name so an unlistable run directory does not refuse it.
      const st = openClawBridgeStatus(pidState);
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
      const describeKeptRecord = (path: string, kept: PidFileState): string =>
        kept.kind === "running"
          ? `pid file ${path} now belongs to a different process (pid ${kept.pid}) and was kept.`
          : `pid file ${path} no longer holds the record this stop read and was kept.`;
      // Remove only the record this stop decided on: re-read the path and keep
      // a record whose bytes changed, as `office kill` and relay do. Without a
      // record lock, a write between this compare and the unlink can still be
      // removed.
      const removeVerifiedRecord = (
        snapshot: PidRecordSnapshot,
        messages: { removed: string; alreadyGone: string; kept: (kept: PidFileState) => string },
      ): void => {
        const state = snapshot.state;
        if (state.kind === "missing") return;
        const path = state.path;
        const current = snapshotPidRecord(path);
        if (current.state.kind === "missing") {
          console.log(messages.alreadyGone);
          return;
        }
        if (current.state.kind === "unreadable") {
          failures.push(
            `Bridge pid file ${path} could not be read at the final check (${current.state.reason ?? "unknown reason"}); the pid file was kept.`,
          );
          return;
        }
        if (!pidRecordBytesEqual(current.raw, snapshot.raw)) {
          console.log(messages.kept(current.state));
          return;
        }
        const removal = remove(path);
        if (removal === "removed") console.log(messages.removed);
        else if (removal === "already gone") console.log(messages.alreadyGone);
      };
      for (const entry of files) {
        const planned: PidRecordSnapshot = { state: entry.state, raw: entry.raw };
        const state = entry.state;
        if (state.kind === "missing") continue;
        if (state.kind === "unreadable") {
          failures.push(
            `Bridge pid file ${state.path} ${state.reason ?? "could not be read"}, so its process identity cannot be verified; the pid file was kept. Check that process and stop it yourself, or remove ${state.path} if the bridge is not running.`,
          );
          continue;
        }
        if (state.kind === "unverified") {
          failures.push(
            `Bridge pid file ${state.path} names pid ${state.pid}, but that process's identity cannot be verified; the pid file was kept. Check that pid and stop it yourself, or remove ${state.path} if the bridge is not running.`,
          );
          continue;
        }
        if (state.kind === "invalid") {
          // An invalid record was never verified: it may be a torn write from a
          // live bridge. Keep it and refuse, as the unreadable branch does.
          failures.push(
            `Bridge pid file ${state.path} is invalid (${state.reason}), so the bridge's process identity cannot be verified; the pid file was kept. Check whether a bridge is running, and remove ${state.path} by hand only if none is.`,
          );
          continue;
        }
        if (state.kind === "stale") {
          removeVerifiedRecord(planned, {
            removed: `Stale pid file removed: ${state.path}.`,
            alreadyGone: `Pid file already gone: ${state.path}.`,
            kept: (kept) => `Stale pid file not removed; ${describeKeptRecord(state.path, kept)}`,
          });
          continue;
        }
        // The up-front classification is the plan, not the decision: re-read
        // this file immediately before acting on it and signal only the same
        // pid with the same token.
        const decision = bridgeStopRecordReader?.(state.path) ?? snapshotPidRecord(state.path);
        const fresh = decision.state;
        if (fresh.kind !== "running" || fresh.pid !== state.pid || fresh.startToken !== state.startToken) {
          const unproven = `The bridge process (pid ${state.pid}) may still be running; check it with ps -p ${state.pid} and stop it yourself.`;
          if (fresh.kind === "stale" && fresh.pid === state.pid && processIsGone(state.pid, state.startToken)) {
            // A stale re-read for the pid this stop verified is a completed
            // stop only when the process it verified — this pid with this start
            // token — is gone. The stale classification compares the re-read
            // record's own token, which a rewrite can change. The record is
            // left in place, as relay leaves it: it may belong to a new bridge.
            console.log(`Bridge (pid ${state.pid}) stopped; pid file ${fresh.path} is stale.`);
          } else if (fresh.kind === "stale" && fresh.pid === state.pid) {
            failures.push(
              `Bridge pid file ${fresh.path} holds a stale record for pid ${fresh.pid}, but it does not prove the process this stop verified is gone; it was not signalled and the pid file was kept. ${unproven}`,
            );
          } else if (fresh.kind === "missing") {
            failures.push(
              `Bridge pid file ${state.path} disappeared before it was signalled; it was not signalled. ${unproven}`,
            );
          } else if (fresh.kind === "invalid") {
            failures.push(
              `Bridge pid file ${fresh.path} is now invalid; it was not signalled and the pid file was kept. ${unproven}`,
            );
          } else if (fresh.kind === "stale") {
            failures.push(
              `Bridge pid file ${fresh.path} now holds a stale record for pid ${fresh.pid}, not the planned pid ${state.pid}; it was not signalled and the pid file was kept. ${unproven}`,
            );
          } else if (fresh.kind === "unreadable") {
            failures.push(
              `Bridge pid file ${fresh.path} ${fresh.reason ?? "could not be read"}, so its process identity cannot be verified; the pid file was kept. ${unproven}`,
            );
          } else if (fresh.kind === "unverified") {
            failures.push(
              `Bridge pid file ${fresh.path} names pid ${fresh.pid}, but that process's identity cannot be verified; the pid file was kept. ${unproven}`,
            );
          } else if (fresh.pid !== state.pid) {
            failures.push(
              `Bridge pid file ${fresh.path} now names pid ${fresh.pid}, which is not the planned pid ${state.pid}; it was not signalled and the pid file was kept. ${unproven}`,
            );
          } else {
            failures.push(
              `Bridge pid file ${fresh.path} still names pid ${fresh.pid}, but the process identity changed since it was planned; it was not signalled and the pid file was kept. ${unproven}`,
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
          removeVerifiedRecord(decision, {
            removed: `Pid file removed: ${state.path}.`,
            alreadyGone: `Pid file already gone: ${state.path}.`,
            kept: (kept) => `Pid file not removed; ${describeKeptRecord(state.path, kept)}`,
          });
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
          removeVerifiedRecord(decision, {
            removed: `Stale pid file removed: ${state.path}.`,
            alreadyGone: `Pid file already gone: ${state.path}.`,
            kept: (kept) => `Recorded bridge process (pid ${state.pid}) is gone; ${describeKeptRecord(state.path, kept)}`,
          });
          continue;
        }
        if (!(await waitForBridgeExit(state.pid))) {
          failures.push(`Bridge could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
          continue;
        }
        stopped.add(state.pid);
        removeVerifiedRecord(decision, {
          removed: `Bridge (pid ${state.pid}) stopped; pid file removed: ${state.path}.`,
          alreadyGone: `Bridge (pid ${state.pid}) stopped; pid file already gone: ${state.path}.`,
          kept: (kept) => `Bridge (pid ${state.pid}) stopped; ${describeKeptRecord(state.path, kept)}`,
        });
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
      if (args.json) {
        // One directory read and one classification pass feed every field, and
        // a single `pidState` probe per unverified pid decides both that
        // record's kind and its promotion into `bridges`, so no two fields of
        // the document can describe different snapshots.
        const entries = bridgePidFiles();
        const { running, liveness } = bridgeStatusSnapshot(entries);
        // The top-level `running`, `pid` and `port` describe the OpenClaw
        // record only. `bridges` lists running records PLUS unverified records
        // whose pid is alive; `records` lists every pid record with its kind, its
        // pid when the kind has one, and a reason when an unreadable or invalid
        // record has one. An unverified record the probe finds gone is listed as `stale`.
        const openclaw = running.find((entry) => entry.adapter === "openclaw");
        const status = {
          running: openclaw !== undefined,
          ...(openclaw === undefined ? {} : { pid: openclaw.pid }),
          ...(openclaw?.port === undefined ? {} : { port: openclaw.port }),
          ...(openclaw === undefined ? {} : { adapter: openclaw.adapter }),
          ...(running.length === 0 ? {} : { bridges: running }),
          records: entries.map(({ adapter, path, state }) => {
            if (state.kind === "unverified") {
              return {
                adapter,
                path,
                state: liveness.get(state.pid) === "alive" ? "unverified" : "stale",
                pid: state.pid,
              };
            }
            const pid = state.kind === "running" || state.kind === "stale" ? state.pid : undefined;
            const reason =
              state.kind === "invalid" || state.kind === "unreadable" ? state.reason : undefined;
            return {
              adapter,
              path,
              state: state.kind,
              ...(pid === undefined ? {} : { pid }),
              ...(reason === undefined ? {} : { reason }),
            };
          }),
        };
        console.log(JSON.stringify(status));
      } else {
        const entries = bridgePidFiles();
        const running = entries.filter(({ state }) => state.kind === "running");
        if (running.length > 0) {
          for (const { state, adapter, port } of running) {
            if (state.kind !== "running") continue;
            const portText = port === undefined ? "" : `, port=${port}`;
            console.log(`Bridge running: adapter=${adapter}, pid=${state.pid}${portText}`);
          }
        } else {
          // A bad or unverified record says nothing about a bridge process.
          const unproven = entries.filter(
            ({ state }) =>
              state.kind === "invalid" ||
              state.kind === "stale" ||
              state.kind === "unverified" ||
              state.kind === "unreadable",
          );
          if (unproven.length === 0) {
            console.log("Bridge is not running.");
          } else {
            for (const { state } of unproven) {
              if (
                state.kind === "invalid" ||
                state.kind === "stale" ||
                state.kind === "unverified" ||
                state.kind === "unreadable"
              ) {
                console.log(`Bridge state unknown (${state.kind} pid file ${state.path}).`);
              }
            }
          }
        }
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
