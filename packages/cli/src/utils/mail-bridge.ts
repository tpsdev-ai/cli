/**
 * TPS Mail Bridge — Legacy compatibility wrapper
 *
 * The bridge is now pluggable. See packages/cli/src/bridge/ for the
 * adapter-based architecture. This file re-exports the OpenClaw adapter
 * for backward compatibility.
 */

export {
  assertBridgeAdapterName,
  BRIDGE_ADAPTER_NAME_RE,
  BridgeCore,
  validateAgentId,
  validateBridgeAdapterName,
} from "../bridge/core.js";
export type { BridgeEnvelope } from "../bridge/adapter.js";
export { OpenClawAdapter } from "../bridge/openclaw-adapter.js";
export { StdioAdapter } from "../bridge/stdio-adapter.js";

import { BridgeCore } from "../bridge/core.js";
import { validateBridgeAdapterName } from "../bridge/adapter.js";
import { OpenClawAdapter, type OpenClawAdapterConfig } from "../bridge/openclaw-adapter.js";
import { pidState, type PidState } from "@tpsdev-ai/agent";
import { readdirSync } from "node:fs";
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
  /** The bytes `state` was classified from; a failed read is null. */
  raw: Buffer | null;
  port?: number;
  adapter: string;
}

/** `BridgeCore.start` writes `bridge-<adapter>.pid`. Discovery accepts an
 *  adapter part of lowercase ASCII letters only. The legacy name
 *  `mail-bridge.pid` is treated as the OpenClaw bridge. */
const BRIDGE_PID_PREFIX = "bridge-";
const BRIDGE_PID_SUFFIX = ".pid";
const LEGACY_PID_NAME = "mail-bridge.pid";
const LEGACY_ADAPTER = "openclaw";
/** The OpenClaw records, in the order the start check reads them. */
const OPENCLAW_PID_NAMES = ["bridge-openclaw.pid", "mail-bridge.pid"] as const;

function bridgePidRecordAdapter(name: string): string | null {
  if (name === LEGACY_PID_NAME) return LEGACY_ADAPTER;
  if (!name.startsWith(BRIDGE_PID_PREFIX) || !name.endsWith(BRIDGE_PID_SUFFIX)) return null;
  const adapter = name.slice(BRIDGE_PID_PREFIX.length, -BRIDGE_PID_SUFFIX.length);
  return validateBridgeAdapterName(adapter) ? adapter : null;
}

function classifyBridgePidFile(path: string, adapter: string): BridgePidFileEntry | null {
  let port: number | undefined;
  let raw: Buffer | null = null;
  const state = readPidFile(path, undefined, (content, bytes) => {
    raw = bytes;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.port === "number") port = parsed.port;
    } catch {
      /* not JSON */
    }
  });
  if (state.kind === "missing") return null;
  return { path, state, raw, port, adapter };
}

/** The run-directory listing `bridgePidFiles` uses; replaceable in tests. */
let listRunDir = (dir: string): string[] => readdirSync(dir);

/** Replace the run-directory listing; returns the previous reader. A test uses
 *  this to count how many times one `status --json` call reads the directory. */
export function setRunDirReader(reader: (dir: string) => string[]): (dir: string) => string[] {
  const previous = listRunDir;
  listRunDir = reader;
  return previous;
}

/** The bridge pid records discovery accepts, with their strict classification. */
export function bridgePidFiles(adapter?: string): BridgePidFileEntry[] {
  const pidDir = join(homeDir(), ".tps", "run");
  let names: string[];
  try {
    names = listRunDir(pidDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return [];
    throw new Error(
      `Bridge run directory ${pidDir} could not be read (${code}); no bridge pid records can be checked.`,
    );
  }
  const entries: BridgePidFileEntry[] = [];
  for (const name of [...names].sort()) {
    const recordAdapter = bridgePidRecordAdapter(name);
    if (recordAdapter === null) continue;
    if (adapter !== undefined && recordAdapter !== adapter) continue;
    const entry = classifyBridgePidFile(join(pidDir, name), recordAdapter);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The two OpenClaw records, read by name without listing the run directory. */
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

/** The liveness probe the `status --json` snapshot uses; replaceable in tests. */
let statusProbe: (pid: number) => PidState = pidState;

/** Replace the `status --json` liveness probe; returns the previous probe. A
 *  test uses this to count how often one `status --json` call probes a pid. */
export function setStatusProbe(probe: (pid: number) => PidState): (pid: number) => PidState {
  const previous = statusProbe;
  statusProbe = probe;
  return previous;
}

/** Probe each unverified pid in `entries` once; a pid recorded in more than one
 *  record is probed once. */
export function probeUnverifiedPids(
  entries: BridgePidFileEntry[],
  probe: (pid: number) => PidState,
): Map<number, PidState> {
  const liveness = new Map<number, PidState>();
  for (const entry of entries) {
    const { state } = entry;
    if (state.kind !== "unverified" || liveness.has(state.pid)) continue;
    liveness.set(state.pid, probe(state.pid));
  }
  return liveness;
}

/** The running records among `entries`: each `running` entry, plus an
 *  `unverified` entry whose pid the probe reports alive. `liveness` carries the
 *  probe result per unverified pid, so a caller that already probed does not
 *  probe again. */
export function runningRecordsFrom(
  entries: BridgePidFileEntry[],
  probe: (pid: number) => PidState = pidState,
  liveness: Map<number, PidState> = probeUnverifiedPids(entries, probe),
): BridgeRunningRecord[] {
  const running: BridgeRunningRecord[] = [];
  for (const entry of entries) {
    const { state, port } = entry;
    let pid: number | undefined;
    if (state.kind === "running") pid = state.pid;
    else if (state.kind === "unverified" && liveness.get(state.pid) === "alive") pid = state.pid;
    if (pid === undefined) continue;
    running.push(port === undefined ? { adapter: entry.adapter, pid } : { adapter: entry.adapter, pid, port });
  }
  return running;
}

/** The running records and the one probe result per unverified pid that a
 *  `status --json` document derives both its `bridges` entry and its `records`
 *  entry from. */
export function bridgeStatusSnapshot(entries: BridgePidFileEntry[]): {
  running: BridgeRunningRecord[];
  liveness: Map<number, PidState>;
} {
  const liveness = probeUnverifiedPids(entries, statusProbe);
  return { running: runningRecordsFrom(entries, statusProbe, liveness), liveness };
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

/** Status of the OpenClaw records, read by name. */
export function openClawBridgeStatus(
  probe: (pid: number) => PidState = pidState,
): { running: boolean; pid?: number; port?: number; adapter?: string } {
  const entries = openClawBridgePidFiles();
  for (const { state } of entries) {
    if (state.kind === "unreadable") {
      throw new Error(`Bridge pid file ${state.path} ${state.reason ?? "could not be read"}; refusing to start.`);
    }
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
