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
  adapter: string;
}

/** `BridgeCore.start` writes `bridge-<adapter>.pid`. Discovery accepts an
 *  adapter part of lowercase ASCII letters only. The legacy name
 *  `mail-bridge.pid` is treated as the OpenClaw bridge. */
const BRIDGE_PID_NAME = /^(?:bridge-([a-z]+)|mail-bridge)\.pid$/;
const LEGACY_ADAPTER = "openclaw";

/** The bridge pid records discovery accepts, with their strict classification. */
export function bridgePidFiles(adapter?: string): BridgePidFileEntry[] {
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
    const recordAdapter = BRIDGE_PID_NAME.exec(name)?.[1] ?? LEGACY_ADAPTER;
    if (adapter !== undefined && recordAdapter !== adapter) continue;
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
    entries.push({ path, state, port, adapter: recordAdapter });
  }
  return entries;
}

export interface BridgeRunningRecord {
  adapter: string;
  pid: number;
  port?: number;
}

/** Every running bridge record discovery accepts, optionally for one adapter. */
export function bridgeRunningRecords(
  probe: (pid: number) => PidState = pidState,
  adapter?: string,
): BridgeRunningRecord[] {
  const running: BridgeRunningRecord[] = [];
  for (const entry of bridgePidFiles(adapter)) {
    const { state, port } = entry;
    let pid: number | undefined;
    if (state.kind === "running") pid = state.pid;
    else if (state.kind === "unverified" && probe(state.pid) === "alive") pid = state.pid;
    if (pid === undefined) continue;
    running.push(port === undefined ? { adapter: entry.adapter, pid } : { adapter: entry.adapter, pid, port });
  }
  return running;
}

export function bridgeStatus(
  probe: (pid: number) => PidState = pidState,
  adapter?: string,
): { running: boolean; pid?: number; port?: number; adapter?: string } {
  const [first] = bridgeRunningRecords(probe, adapter);
  if (!first) return { running: false };
  const status: { running: boolean; pid?: number; port?: number; adapter?: string } = {
    running: true,
    pid: first.pid,
    adapter: first.adapter,
  };
  if (first.port !== undefined) status.port = first.port;
  return status;
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
