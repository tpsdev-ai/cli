/**
 * flair-init.ts — Bootstrap a local Flair (Harper) instance for a TPS agent.
 *
 * tps flair init [--agent-id <id>] [--port <port>] [--admin-pass <pass>]
 *
 * Steps:
 *   1. Check for Node.js
 *   2. Ensure @harperfast/harper is installed
 *   3. Start Harper (env-only config, no pre-seeded config file)
 *   4. Poll health endpoint
 *   5. Generate Ed25519 keypair if missing
 *   6. Seed agent via operations API (insert into Agent table)
 *   7. Verify Ed25519 auth works
 *   8. Save flair-sync.json config
 *   9. Output connection info
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import * as ed from "@noble/ed25519";
import { generateKeyPair } from "../utils/identity.js";
import { FlairClient } from "../utils/flair-client.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_AGENT_ID = "anvil";
const DEFAULT_PORT = 9926;
const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASS = "test123";
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 500;

// ─── Paths ────────────────────────────────────────────────────────────────────

function defaultSecretsDir(): string {
  return join(homedir(), ".tps", "secrets", "flair");
}

function privKeyPath(agentId: string, secretsDirectory: string): string {
  return join(secretsDirectory, `${agentId}-priv.key`);
}

function pubKeyPath(agentId: string, secretsDirectory: string): string {
  return join(secretsDirectory, `${agentId}-pub.key`);
}

function defaultSyncConfigPath(): string {
  return join(homedir(), ".tps", "flair-sync.json");
}

// ─── Harper binary ────────────────────────────────────────────────────────────

function findHarperBin(): string | null {
  // Prefer local node_modules (flair repo)
  const localBin = join(process.cwd(), "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js");
  if (existsSync(localBin)) return localBin;

  // Global node_modules
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const globalBin = join(globalRoot, "@harperfast", "harper", "dist", "bin", "harper.js");
    if (existsSync(globalBin)) return globalBin;
  } catch {
    // ignore
  }

  return null;
}

// ─── Health check ─────────────────────────────────────────────────────────────

async function waitForHealth(
  httpPort: number,
  adminUser: string,
  adminPass: string,
  timeoutMs: number
): Promise<void> {
  const url = `http://127.0.0.1:${httpPort}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(2000),
      });
      if (res.status > 0) {
        return; // Harper is alive
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Harper at port ${httpPort} did not respond within ${timeoutMs}ms (${attempt} attempts)`);
}

// ─── Keypair generation ───────────────────────────────────────────────────────

/**
 * Returns the raw 32-byte public key as base64url (no padding).
 * Harper's Agent table expects the raw 32-byte key, not SPKI.
 */
function publicKeyBase64url(pubKeyBytes: Uint8Array): string {
  return Buffer.from(pubKeyBytes).toString("base64url");
}

async function ensureKeyPair(
  agentId: string,
  secretsDirectory: string
): Promise<{ privPath: string; pubKeyB64url: string }> {
  const privPath = privKeyPath(agentId, secretsDirectory);
  const pubPath = pubKeyPath(agentId, secretsDirectory);

  if (existsSync(privPath)) {
    // Keys already exist — re-derive public key from existing 32-byte seed
    const seed = new Uint8Array(readFileSync(privPath));
    const pubKeyBytes = await ed.getPublicKeyAsync(seed);
    return { privPath, pubKeyB64url: publicKeyBase64url(pubKeyBytes) };
  }

  // Generate new keypair
  const kp = generateKeyPair();
  mkdirSync(secretsDirectory, { recursive: true });

  // Write raw 32-byte seed as private key
  writeFileSync(privPath, Buffer.from(kp.signing.privateKey));
  chmodSync(privPath, 0o600);

  // Write raw 32-byte public key
  writeFileSync(pubPath, Buffer.from(kp.signing.publicKey));

  return { privPath, pubKeyB64url: publicKeyBase64url(kp.signing.publicKey) };
}

// ─── Operations API ───────────────────────────────────────────────────────────

async function seedAgentViaOpsApi(
  opsPort: number,
  agentId: string,
  agentName: string,
  pubKeyB64url: string,
  adminUser: string,
  adminPass: string
): Promise<void> {
  const url = `http://127.0.0.1:${opsPort}/`;
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");

  // Use operations API insert
  const body = {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [
      {
        id: agentId,
        name: agentName,
        publicKey: pubKeyB64url,
        createdAt: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 409/duplicate is OK — agent already exists
    if (res.status === 409 || text.includes("duplicate") || text.includes("already exists")) {
      return;
    }
    throw new Error(`Operations API insert failed (${res.status}): ${text}`);
  }
}

// ─── Verify Ed25519 auth ──────────────────────────────────────────────────────

async function verifyEd25519Auth(
  httpPort: number,
  agentId: string,
  privPath: string
): Promise<void> {
  const client = new FlairClient({
    agentId,
    baseUrl: `http://127.0.0.1:${httpPort}`,
    keyPath: privPath,
  });

  // Try a lightweight authenticated request
  try {
    await client.request<unknown>("GET", `/Agent/${agentId}`);
  } catch (err: any) {
    throw new Error(`Ed25519 auth verification failed: ${err.message}`);
  }
}

// ─── Save sync config ─────────────────────────────────────────────────────────

function saveSyncConfig(agentId: string, httpPort: number, configPath: string): void {
  const cfg = {
    localUrl: `http://localhost:${httpPort}`,
    remoteUrl: "http://localhost:9927",
    agentId,
    lastSyncTimestamp: new Date(0).toISOString(),
  };
  mkdirSync(join(configPath, ".."), { recursive: true });
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, configPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface FlairInitOptions {
  agentId?: string;
  port?: number;
  adminPass?: string;
  /** Skip Harper startup — assume already running (for tests) */
  skipStart?: boolean;
  /** Override ops port (default: httpPort + 1) */
  opsPort?: number;
  /** Override secrets directory (for tests) */
  secretsDirOverride?: string;
  /** Override sync config path (for tests) */
  syncConfigPathOverride?: string;
}

export interface FlairInitResult {
  agentId: string;
  httpUrl: string;
  privKeyPath: string;
  pubKeyB64url: string;
  syncConfigPath: string;
  alreadyRunning: boolean;
}

export async function runFlairInit(opts: FlairInitOptions = {}): Promise<FlairInitResult> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const httpPort = opts.port ?? DEFAULT_PORT;
  const opsPort = opts.opsPort ?? httpPort + 1;
  const adminPass = opts.adminPass ?? DEFAULT_ADMIN_PASS;
  const adminUser = DEFAULT_ADMIN_USER;
  const secretsDirectory = opts.secretsDirOverride ?? defaultSecretsDir();
  const syncCfgPath = opts.syncConfigPathOverride ?? defaultSyncConfigPath();

  // ── Step 1: Check Node.js ──────────────────────────────────────────────────
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major < 18) {
    throw new Error(`Node.js >= 18 required (found ${nodeVersion})`);
  }

  let alreadyRunning = false;

  if (!opts.skipStart) {
    // ── Step 2: Find @harperfast/harper ──────────────────────────────────────
    const harperBin = findHarperBin();
    if (!harperBin) {
      throw new Error(
        "@harperfast/harper not found in node_modules.\n" +
          "Run: npm install @harperfast/harper  (or bun add @harperfast/harper)"
      );
    }

    // ── Step 3: Check if already running ─────────────────────────────────────
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status > 0) {
        alreadyRunning = true;
        console.log(`[flair-init] Harper already running on port ${httpPort} — skipping start`);
      }
    } catch {
      // Not running — start it
    }

    if (!alreadyRunning) {
      // ── Step 3: Start Harper ────────────────────────────────────────────────
      const installDir = join(homedir(), ".tps", "harper-data");
      mkdirSync(installDir, { recursive: true });

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ROOTPATH: installDir,
        DEFAULTS_MODE: "dev",
        HDB_ADMIN_USERNAME: adminUser,
        HDB_ADMIN_PASSWORD: adminPass,
        THREADS_COUNT: "1",
        NODE_HOSTNAME: "localhost",
        HTTP_PORT: String(httpPort),
        OPERATIONSAPI_NETWORK_PORT: String(opsPort),
        LOCAL_STUDIO: "false",
      };

      // Install first
      console.log("[flair-init] Installing Harper...");
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const install = spawn(process.execPath, [harperBin, "install"], { env, cwd: process.cwd() });
        install.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        install.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
        install.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Harper install exited ${code}: ${output}`));
        });
        install.on("error", reject);
        setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
      });

      // Start Harper (detached so it outlives this process)
      console.log(`[flair-init] Starting Harper on port ${httpPort}...`);
      const proc = spawn(process.execPath, [harperBin, "dev", "."], {
        env,
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
    }

    // ── Step 4: Wait for health ───────────────────────────────────────────────
    console.log("[flair-init] Waiting for Harper health check...");
    await waitForHealth(httpPort, adminUser, adminPass, STARTUP_TIMEOUT_MS);
    console.log("[flair-init] Harper is healthy ✓");
  }

  // ── Step 5: Generate/load Ed25519 keypair ─────────────────────────────────
  console.log(`[flair-init] Ensuring keypair for agent '${agentId}'...`);
  const { privPath, pubKeyB64url } = await ensureKeyPair(agentId, secretsDirectory);
  console.log(`[flair-init] Private key: ${privPath} ✓`);

  // ── Step 6: Seed agent via operations API ─────────────────────────────────
  console.log(`[flair-init] Seeding agent '${agentId}' via operations API...`);
  await seedAgentViaOpsApi(opsPort, agentId, agentId, pubKeyB64url, adminUser, adminPass);
  console.log(`[flair-init] Agent '${agentId}' registered ✓`);

  // ── Step 7: Verify Ed25519 auth ───────────────────────────────────────────
  console.log("[flair-init] Verifying Ed25519 auth...");
  await verifyEd25519Auth(httpPort, agentId, privPath);
  console.log("[flair-init] Ed25519 auth verified ✓");

  // ── Step 8: Save flair-sync.json ──────────────────────────────────────────
  saveSyncConfig(agentId, httpPort, syncCfgPath);
  console.log(`[flair-init] Config saved: ${syncCfgPath} ✓`);

  // ── Step 9: Output connection info ────────────────────────────────────────
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  console.log("\n✅ Flair initialized successfully");
  console.log(`   Agent ID:    ${agentId}`);
  console.log(`   Flair URL:   ${httpUrl}`);
  console.log(`   Private key: ${privPath}`);
  console.log(`   Sync config: ${syncCfgPath}`);
  console.log(`\n   Export: FLAIR_URL=${httpUrl}`);

  return {
    agentId,
    httpUrl,
    privKeyPath: privPath,
    pubKeyB64url,
    syncConfigPath: syncCfgPath,
    alreadyRunning,
  };
}
