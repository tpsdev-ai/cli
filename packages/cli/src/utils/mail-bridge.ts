/**
 * TPS Mail Bridge — Legacy compatibility wrapper
 *
 * The bridge is now pluggable. See packages/cli/src/bridge/ for the
 * adapter-based architecture. This file re-exports the OpenClaw adapter
 * for backward compatibility.
 */

export { BridgeCore, validateAgentId } from "../bridge/core.js";
export type { BridgeEnvelope } from "../bridge/adapter.js";
export { OpenClawAdapter } from "../bridge/openclaw-adapter.js";
export { StdioAdapter } from "../bridge/stdio-adapter.js";

import { BridgeCore } from "../bridge/core.js";
import { OpenClawAdapter, type OpenClawAdapterConfig } from "../bridge/openclaw-adapter.js";
import { pidState, type PidState } from "@tpsdev-ai/agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./home.js";
import { readPidFile, type PidFileState } from "./pid-file.js";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:mail");


// Legacy BridgeConfig (maps to new structure)
export interface BridgeConfig {
  port?: number;
  openClawUrl?: string;
  bridgeAgentId?: string;
  mailDir?: string;
  defaultAgentId?: string;
}

export interface BridgePidFileEntry {
  path: string;
  state: PidFileState;
  port?: number;
}

/** `BridgeCore.start` writes `bridge-<adapter>.pid`; every adapter name in
 *  the agent registry (`openclaw`, `discord`, `stdio`) uses lowercase ASCII
 *  letters only. The legacy name is `mail-bridge.pid`. */
const BRIDGE_PID_NAME = /^(?:bridge-[a-z]+|mail-bridge)\.pid$/;

/** The bridge pid files that exist, with their strict classification. */
export function bridgePidFiles(): BridgePidFileEntry[] {
  const pidDir = join(homeDir(), ".tps", "run");
  let names: string[];
  try {
    names = readdirSync(pidDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return [];
    throw new Error(
      `Bridge run directory ${pidDir} could not be read (${code}); no bridge pid records can be checked.`,
    );
  }
  const entries: BridgePidFileEntry[] = [];
  for (const name of names.filter((entry) => BRIDGE_PID_NAME.test(entry)).sort()) {
    const path = join(pidDir, name);
    const state = readPidFile(path);
    if (state.kind === "missing") continue;
    let port: number | undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof raw.port === "number") port = raw.port;
    } catch {
      /* not JSON, or unreadable — the pid state is what this reader decides on */
    }
    entries.push({ path, state, port });
  }
  return entries;
}

export function bridgeStatus(probe: (pid: number) => PidState = pidState): { running: boolean; pid?: number; port?: number } {
  for (const entry of bridgePidFiles()) {
    const { state, port } = entry;
    let pid: number | undefined;
    if (state.kind === "running") pid = state.pid;
    else if (state.kind === "unverified" && probe(state.pid) === "alive") pid = state.pid;
    if (pid === undefined) continue;
    return port === undefined ? { running: true, pid } : { running: true, pid, port };
  }
  return { running: false };
}

export function startBridgeDaemon(config: BridgeConfig = {}): void {
  const adapterConfig: OpenClawAdapterConfig = {
    port: config.port,
    openClawUrl: config.openClawUrl,
  };

  const adapter = new OpenClawAdapter(adapterConfig);
  const core = new BridgeCore(adapter, {
    bridgeAgentId: config.bridgeAgentId,
    mailDir: config.mailDir,
    defaultAgentId: config.defaultAgentId,
  });

  core.start().catch((e) => {
    serror(`Bridge start failed: ${e}`);
    process.exit(1);
  });

  const shutdown = () => {
    core.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
