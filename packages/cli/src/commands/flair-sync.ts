/**
 * flair-sync.ts — Bidirectional Flair memory sync daemon
 *
 * Pushes new/updated local Anvil memories to rockit's primary Flair via tunnel.
 *
 * tps flair sync [--once] [--interval <seconds>] [--dry-run]
 *
 * Config: ~/.tps/flair-sync.json
 * {
 *   "localUrl": "http://localhost:9926",
 *   "remoteUrl": "http://localhost:9927",
 *   "agentId": "anvil",
 *   "lastSyncTimestamp": "2026-01-01T00:00:00.000Z"
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FlairClient, Memory, defaultFlairKeyPath } from "../utils/flair-client.js";

const CONFIG_PATH = join(homedir(), ".tps", "flair-sync.json");
const SECRETS_DIR = join(homedir(), ".tps", "secrets");

// ─── Config ──────────────────────────────────────────────────────────────────

interface FlairSyncConfig {
  localUrl: string;
  remoteUrl: string;
  agentId: string;
  lastSyncTimestamp: string;
}

function loadConfig(): FlairSyncConfig {
  const defaults: FlairSyncConfig = {
    localUrl: "http://localhost:9926",
    remoteUrl: "http://localhost:9927",
    agentId: "anvil",
    lastSyncTimestamp: new Date(0).toISOString(),
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg: FlairSyncConfig): void {
  mkdirSync(join(homedir(), ".tps"), { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, CONFIG_PATH);
}

// ─── Content hash ─────────────────────────────────────────────────────────────

/** Stable SHA-256 hash of the memory content for dedup. */
function contentHash(m: Memory): string {
  return createHash("sha256").update(m.content ?? "").digest("hex").slice(0, 16);
}

// ─── Sync logic ───────────────────────────────────────────────────────────────

export interface SyncResult {
  pushed: number;
  skipped: number;
  errors: string[];
  syncedAt: string;
}

export async function runFlairSync(opts: {
  once?: boolean;
  interval?: number;
  dryRun?: boolean;
  verbose?: boolean;
  /** Override config path (for testing) */
  configPath?: string;
  /** Override key path (for testing) */
  keyPath?: string;
}): Promise<void> {
  const once = opts.once !== false; // default: single run
  const intervalSec = opts.interval ?? 300;
  const dryRun = opts.dryRun ?? false;
  const verbose = opts.verbose ?? false;

  const log = (...args: unknown[]) => console.log(...args);
  const debug = verbose ? log : () => {};

  async function runOnce(): Promise<SyncResult> {
    const cfg = opts.configPath
      ? (() => {
          const defaults: FlairSyncConfig = {
            localUrl: "http://localhost:9926",
            remoteUrl: "http://localhost:9927",
            agentId: "anvil",
            lastSyncTimestamp: new Date(0).toISOString(),
          };
          if (!existsSync(opts.configPath!)) return defaults;
          try { return { ...defaults, ...JSON.parse(readFileSync(opts.configPath!, "utf-8")) }; }
          catch { return defaults; }
        })()
      : loadConfig();
    const keyPath = opts.keyPath ?? defaultFlairKeyPath(cfg.agentId);

    if (!existsSync(keyPath)) {
      throw new Error(`Flair key not found at ${keyPath}. Run: tps agent create --id ${cfg.agentId}`);
    }

    const local = new FlairClient({ baseUrl: cfg.localUrl, agentId: cfg.agentId, keyPath });
    const remote = new FlairClient({ baseUrl: cfg.remoteUrl, agentId: cfg.agentId, keyPath });

    // Check tunnel reachability before proceeding
    const remoteUp = await remote.ping();
    if (!remoteUp) {
      throw new Error(`Remote Flair at ${cfg.remoteUrl} is not reachable (tunnel down?)`);
    }

    // Fetch all local memories for this agent
    debug(`[flair-sync] Fetching local memories from ${cfg.localUrl}...`);
    let localMemories: Memory[];
    try {
      localMemories = await local.listMemories(1000);
    } catch (err: any) {
      throw new Error(`Failed to list local memories: ${err.message}`);
    }

    // Filter to memories updated after lastSyncTimestamp
    const lastSync = new Date(cfg.lastSyncTimestamp);
    const toSync = localMemories.filter((m) => {
      const ts = new Date(m.updatedAt ?? m.createdAt ?? 0);
      return ts > lastSync;
    });

    debug(`[flair-sync] ${localMemories.length} total local memories, ${toSync.length} new/updated since ${cfg.lastSyncTimestamp}`);

    let pushed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const syncedAt = new Date().toISOString();

    for (const m of toSync) {
      // Sherlock guard: skip memories whose agentId doesn't match the
      // authenticated agent — prevents pushing another agent's memories
      // (e.g. from a corrupted or tampered local store).
      if (m.agentId !== cfg.agentId) {
        console.warn(`[flair-sync] SKIP ${m.id}: agentId mismatch (got "${m.agentId}", expected "${cfg.agentId}")`);
        skipped++;
        continue;
      }

      const hash = contentHash(m);
      try {
        // Check if remote already has this exact content (dedup by content hash)
        let remoteHas = false;
        try {
          const existing = await remote.getMemory(m.id);
          const existingHash = contentHash(existing);
          if (existingHash === hash) {
            debug(`[flair-sync] SKIP ${m.id} (same content hash)`);
            skipped++;
            remoteHas = true;
          }
        } catch {
          // 404 or error — memory doesn't exist remotely, push it
        }

        if (!remoteHas) {
          if (dryRun) {
            log(`[dry-run] Would push: ${m.id} (${m.type ?? "?"}, ${m.durability ?? "standard"})`);
            pushed++;
          } else {
            debug(`[flair-sync] PUSH ${m.id}`);
            await remote.request("PUT", `/Memory/${m.id}`, {
              ...m,
              // Preserve all fields; don't change agentId or createdAt
            });
            pushed++;
          }
        }
      } catch (err: any) {
        const msg = `Failed to sync memory ${m.id}: ${err.message}`;
        errors.push(msg);
        console.error(`[flair-sync] ERROR: ${msg}`);
      }
    }

    // Update lastSyncTimestamp only on non-dry-run success
    if (!dryRun && errors.length < toSync.length) {
      const updatedCfg = { ...cfg, lastSyncTimestamp: syncedAt };
      if (opts.configPath) {
        const tmp = opts.configPath + ".tmp";
        writeFileSync(tmp, JSON.stringify(updatedCfg, null, 2) + "\n", "utf-8");
        renameSync(tmp, opts.configPath);
      } else {
        saveConfig(updatedCfg);
      }
    }

    return { pushed, skipped, errors, syncedAt };
  }

  if (once || !opts.interval) {
    // Single run
    const result = await runOnce();
    log(`[flair-sync] Done: pushed=${result.pushed} skipped=${result.skipped} errors=${result.errors.length}`);
    if (result.errors.length > 0) process.exit(1);
    return;
  }

  // Daemon mode: repeat every intervalSec seconds
  log(`[flair-sync] Starting daemon, interval=${intervalSec}s`);
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    try {
      const result = await runOnce();
      log(`[flair-sync] ${result.syncedAt}: pushed=${result.pushed} skipped=${result.skipped} errors=${result.errors.length}`);
    } catch (err: any) {
      console.error(`[flair-sync] Sync failed: ${err.message}`);
    }
    if (!running) break;
    // Sleep intervalSec seconds
    await new Promise<void>((resolve) => setTimeout(resolve, intervalSec * 1000));
  }

  log("[flair-sync] Daemon stopped.");
}
