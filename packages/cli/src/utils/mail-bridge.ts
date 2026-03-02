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
  const pidPath = join(homedir(), ".tps", "run", "bridge-openclaw.pid");
  if (!existsSync(pidPath)) return { running: false };
  try {
    const raw = JSON.parse(readFileSync(pidPath, "utf-8"));
    process.kill(raw.pid, 0);
    return { running: true, pid: raw.pid, port: raw.port };
  } catch {
    return { running: false };
  }
}

export function startBridgeDaemon(config: BridgeConfig = {}): void {
  const adapterConfig: OpenClawAdapterConfig = {
    port: config.port,
    openClawUrl: config.openClawUrl,
  };

  const adapter = new OpenClawAdapter(adapterConfig);
  const core = new BridgeCore(adapter, {
    bridgeAgentId: config.bridgeAgentId ?? "openclaw-bridge",
    mailDir: config.mailDir,
    defaultAgentId: config.defaultAgentId,
  });

  core.start().catch((e) => {
    console.error(`Bridge start failed: ${e}`);
    process.exit(1);
  });

  const shutdown = () => {
    core.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Re-export sendMail and mailboxDir for test compat
export function sendMail(mailDir: string, to: string, from: string, body: string, headers?: Record<string, string>): void {
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { randomUUID } = require("node:crypto");
  const fresh = join(mailDir, to, "new");
  mkdirSync(fresh, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const msg = {
    id, from, to,
    timestamp: new Date().toISOString(),
    headers: headers ?? {
      "X-TPS-Trust": "external",
      "X-TPS-Sender": from,
    },
    body,
  };
  writeFileSync(join(fresh, `${id}.json`), JSON.stringify(msg, null, 2), "utf-8");
}

export function mailboxDir(mailDir: string, agentId: string) {
  const { join } = require("node:path");
  const base = join(mailDir, agentId);
  return { fresh: join(base, "new"), cur: join(base, "cur") };
}
