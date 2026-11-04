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
import { lstatSync, readFileSync, readdirSync } from "node:fs";
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

export type BridgePidEntryState = PidFileState | { kind: "not-regular"; path: string };

export interface BridgePidFileEntry {
  path: string;
  state: BridgePidEntryState;
  port?: number;
  adapter: string;
}

/** `BridgeCore.start` writes `bridge-<adapter>.pid`. Discovery accepts an
 *  adapter part of lowercase ASCII letters only. The legacy name
 *  `mail-bridge.pid` is treated as the OpenClaw bridge. */
const BRIDGE_PID_NAME = /^(?:bridge-([a-z]+)|mail-bridge)\.pid$/;
const LEGACY_ADAPTER = "openclaw";
/** The OpenClaw records, in the order the start check reads them. */
const OPENCLAW_PID_NAMES = ["bridge-openclaw.pid", "mail-bridge.pid"] as const;

/** Classify one record path. A non-regular entry is never read: reading a
 *  FIFO blocks until a writer opens it. */
function classifyBridgePidFile(path: string, adapter: string): BridgePidFileEntry | null {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return null;
    throw new Error(
      `Bridge pid file ${path} could not be inspected (${code}); no bridge pid record can be checked.`,
    );
  }
  if (!isFile) return { path, state: { kind: "not-regular", path }, adapter };
  const state = readPidFile(path);
  if (state.kind === "missing") return null;
  let port: number | undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw.port === "number") port = raw.port;
  } catch {
    /* not JSON, or unreadable — the pid state is what this reader decides on */
  }
  return { path, state, port, adapter };
}

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
    const entry = classifyBridgePidFile(join(pidDir, name), recordAdapter);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The two OpenClaw records, read by name. This does not list the run
 *  directory, so a directory that cannot be listed does not affect it. */
export function openClawBridgePidFiles(): BridgePidFileEntry[] {
  const pidDir = join(homeDir(), ".tps", "run");
  const entries: BridgePidFileEntry[] = [];
  for (const name of OPENCLAW_PID_NAMES) {
    const entry = classifyBridgePidFile(join(pidDir, name), LEGACY_ADAPTER);
    if (entry) entries.push(entry);
  }
  return entries;
}

export interface BridgeRunningRecord {
  adapter: string;
  pid: number;
  port?: number;
}

function runningRecordsFrom(
  entries: BridgePidFileEntry[],
  probe: (pid: number) => PidState,
): BridgeRunningRecord[] {
  const running: BridgeRunningRecord[] = [];
  for (const entry of entries) {
    const { state, port } = entry;
    let pid: number | undefined;
    if (state.kind === "running") pid = state.pid;
    else if (state.kind === "unverified" && probe(state.pid) === "alive") pid = state.pid;
    if (pid === undefined) continue;
    running.push(port === undefined ? { adapter: entry.adapter, pid } : { adapter: entry.adapter, pid, port });
  }
  return running;
}

function statusOf(
  records: BridgeRunningRecord[],
): { running: boolean; pid?: number; port?: number; adapter?: string } {
  const [first] = records;
  if (!first) return { running: false };
  const status: { running: boolean; pid?: number; port?: number; adapter?: string } = {
    running: true,
    pid: first.pid,
    adapter: first.adapter,
  };
  if (first.port !== undefined) status.port = first.port;
  return status;
}

/** Every running bridge record discovery accepts, optionally for one adapter. */
export function bridgeRunningRecords(
  probe: (pid: number) => PidState = pidState,
  adapter?: string,
): BridgeRunningRecord[] {
  return runningRecordsFrom(bridgePidFiles(adapter), probe);
}

/** Status for one adapter's records. `adapter` is required so the result never
 *  describes an arbitrary record discovered for another adapter. */
export function bridgeStatus(
  adapter: string,
  probe: (pid: number) => PidState = pidState,
): { running: boolean; pid?: number; port?: number; adapter?: string } {
  return statusOf(runningRecordsFrom(bridgePidFiles(adapter), probe));
}

/** Status of the OpenClaw records, read by name. Throws when either path
 *  exists but is not a regular file: an unreadable record never licenses a
 *  start. */
export function openClawBridgeStatus(
  probe: (pid: number) => PidState = pidState,
): { running: boolean; pid?: number; port?: number; adapter?: string } {
  const entries = openClawBridgePidFiles();
  const notRegular = entries.find((entry) => entry.state.kind === "not-regular");
  if (notRegular) {
    throw new Error(`Bridge pid file ${notRegular.path} is not a regular file; refusing to start.`);
  }
  return statusOf(runningRecordsFrom(entries, probe));
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
