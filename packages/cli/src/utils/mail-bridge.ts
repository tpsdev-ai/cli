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

export function bridgeStatus(): { running: boolean; pid?: number; port?: number } {
  const { existsSync, readFileSync } = require("node:fs");
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  const home = process.env.HOME ?? homedir();
  const pidDir = join(home, ".tps", "run");
  // Check both new and legacy PID paths
  for (const name of ["bridge-openclaw.pid", "mail-bridge.pid"]) {
    const pidPath = join(pidDir, name);
    if (!existsSync(pidPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(pidPath, "utf-8"));
      process.kill(raw.pid, 0);
      return { running: true, pid: raw.pid, port: raw.port };
    } catch {
      continue;
    }
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
