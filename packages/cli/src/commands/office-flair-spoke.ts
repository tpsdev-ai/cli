/**
 * ops-209a: Flair spoke auto-provisioning for `tps office join --tunnel-via`.
 *
 * After a successful join handshake + launchd supervision install, this module
 * optionally provisions a local Flair (Harper) instance on the remote branch
 * and, if ~/.tps/flair.json has a hub configured, sets up fed-sync from the
 * branch spoke back to the team hub.
 *
 * OS-adaptive: generates systemd units for Linux branches (Ember/Reed/etc.)
 * and launchd plists for macOS branches.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { FlairConfigFile, readFlairConfigFile } from "./flair.js";
import {
  SupervisionManifest,
  readSupervision,
  writeSupervision,
} from "./office-supervision.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FLAIR_PORT = 9926;
const DEFAULT_HARPER_OPS_PORT = 9925;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BranchOS = "linux" | "macos" | "unknown";

export interface FlairPlan {
  mode: "hub-less" | "spoke" | "error";
  error?: string;
  hub?: string;
  auth?: { mode: "admin-pass-file"; path: string };
}

export interface FlairInstallState {
  flairDir: string;
  port: number;
  adminPassPath: string;
  unitName: string;
  os: BranchOS;
  installedAt: string;
}

export interface FedSyncState {
  serviceName: string;
  timerName: string;
  syncConfigPath: string;
  hub: string;
  intervalSeconds: number;
  lastSync: string | null; // ISO timestamp if initial sync succeeded
  installedAt: string;
}

/** Extended supervision manifest with Flair spoke fields (saved atomically). */
export interface ExtendedSupervisionManifest extends SupervisionManifest {
  flair?: FlairInstallState;
  fedSync?: FedSyncState;
}

export interface FlairHealthReport {
  installed: boolean;
  unitActive: boolean;
  port: number;
  flairDir: string;
  apiReachable: boolean;
  fedSyncConfigured: boolean;
  fedSyncActive: boolean;
  lastFedSync: string | null;
}

// ─── Flair plan ───────────────────────────────────────────────────────────────

/**
 * Read ~/.tps/flair.json and return the provisioning plan.
 *
 * Three outcomes:
 *   hub-less    — hub is null: install local Flair, no fed-sync
 *   spoke       — hub + auth both set: install Flair + fed-sync
 *   error       — hub set but auth missing or invalid: abort with message
 */
export function buildFlairPlan(config?: FlairConfigFile): FlairPlan {
  const cfg = config ?? readFlairConfigFile();

  if (cfg.hub === null || cfg.hub === undefined) {
    return { mode: "hub-less" };
  }

  // hub is non-null — auth is required
  if (!cfg.auth) {
    return {
      mode: "error",
      hub: cfg.hub,
      error:
        `Flair hub is configured (${cfg.hub}) but no auth credentials are set.\n` +
        `Run: tps flair set-hub <url> --auth-mode admin-pass-file --auth-path <path>`,
    };
  }

  if (!existsSync(cfg.auth.path)) {
    return {
      mode: "error",
      hub: cfg.hub,
      error:
        `Flair hub auth file not found: ${cfg.auth.path}\n` +
        `Run: tps flair set-hub <url> --auth-mode admin-pass-file --auth-path <path>`,
    };
  }

  return {
    mode: "spoke",
    hub: cfg.hub,
    auth: cfg.auth,
  };
}

// ─── OS detection ─────────────────────────────────────────────────────────────

/**
 * SSH to the remote branch and detect its OS via `uname -s`.
 */
export function detectBranchOS(tunnelVia: string): BranchOS {
  try {
    const out = execSync(`ssh -- "${tunnelVia}" "uname -s"`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
    }).trim();
    if (out === "Linux") return "linux";
    if (out === "Darwin") return "macos";
    return "unknown";
  } catch (e: any) {
    throw new Error(
      `Failed to detect OS on ${tunnelVia}: ${(e as Error).message}`
    );
  }
}

// ─── Systemd unit generation ──────────────────────────────────────────────────

/**
 * Generate a systemd service unit that runs Harper for the branch's Flair spoke.
 *
 * The unit cd's into the flair dir, runs harper.js in dev mode, and sets
 * HARPER_SET_CONFIG for the data directory, ports, and other settings.
 */
export function generateSystemdFlairUnit(
  unitName: string,
  flairDir: string,
  harperDataDir: string,
  port: number = DEFAULT_FLAIR_PORT,
): string {
  // Build the HARPER_SET_CONFIG JSON.
  // Escape the JSON for safe embedding in the systemd Environment line.
  const harperConfig = JSON.stringify({
    rootPath: harperDataDir,
    http: {
      port,
      cors: true,
      corsAccessList: [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
      ],
    },
    operationsApi: {
      network: {
        port: DEFAULT_HARPER_OPS_PORT,
        cors: true,
        corsAccessList: [
          `http://127.0.0.1:${DEFAULT_HARPER_OPS_PORT}`,
          `http://localhost:${DEFAULT_HARPER_OPS_PORT}`,
        ],
        domainSocket: `${harperDataDir}/operations-server`,
      },
    },
    mqtt: { network: { port: null }, webSocket: false },
    localStudio: { enabled: false },
  });

  return `[Unit]
Description=Flair (Harper) spoke for branch office
After=network-online.target

[Service]
Type=simple
User=%u
ExecStart=/bin/sh -c 'cd "${flairDir}" && exec node node_modules/harper/dist/bin/harper.js dev "${flairDir}"'
WorkingDirectory=${flairDir}
Restart=always
RestartSec=10
Environment=HOME=%h
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HARPER_SET_CONFIG=${harperConfig}
StandardOutput=journal
StandardError=journal

# Wait for systemd-notify support or just use simple type
# Harper doesn't notify, so we use simple + give it time

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate a systemd service that runs `tps flair sync --once`
 * (spoke→hub fed-sync). Paired with a timer for periodic execution.
 */
export function generateFedSyncService(
  serviceName: string,
  syncConfigPath: string,
): string {
  return `[Unit]
Description=Flair fed-sync spoke→hub for branch office
After=network-online.target

[Service]
Type=oneshot
User=%u

# Find the tps CLI via bun
ExecStart=/bin/sh -c 'if command -v bun >/dev/null 2>&1; then exec bun run ~/ops/tps/packages/cli/dist/bin/tps.js flair sync --once; elif command -v tps >/dev/null 2>&1; then exec tps flair sync --once; else echo "Neither bun nor tps found"; exit 1; fi'

# Use the sync config written during spokes setup
Environment=TPS_FLAIR_SYNC_CONFIG=${syncConfigPath}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate a systemd timer that triggers the fed-sync service periodically.
 */
export function generateFedSyncTimer(
  timerName: string,
  serviceName: string,
  intervalSeconds: number = 300,
): string {
  return `[Unit]
Description=Periodic Flair fed-sync spoke→hub
Requires=${serviceName}.service

[Timer]
OnCalendar=*-*-* *:*:00/30
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;
}

// ─── launchd plist generation (macOS branches) ────────────────────────────────

/**
 * Generate a launchd plist for Harper on a macOS branch.
 */
export function generateLaunchdFlairPlist(
  label: string,
  flairDir: string,
  harperDataDir: string,
  home: string,
  port: number = DEFAULT_FLAIR_PORT,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${flairDir}/node_modules/harper/dist/bin/harper.js</string>
    <string>dev</string>
    <string>${flairDir}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${flairDir}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${join(home, ".tps", "logs", `flair-${label}.log`)}</string>

  <key>StandardErrorPath</key>
  <string>${join(home, ".tps", "logs", `flair-${label}.error.log`)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${home}</string>
    <key>HARPER_SET_CONFIG</key>
    <string>{"rootPath":"${harperDataDir}","http":{"port":${port},"cors":true,"corsAccessList":["http://127.0.0.1:${port}","http://localhost:${port}"]},"operationsApi":{"network":{"port":${DEFAULT_HARPER_OPS_PORT},"cors":true,"corsAccessList":["http://127.0.0.1:${DEFAULT_HARPER_OPS_PORT}","http://localhost:${DEFAULT_HARPER_OPS_PORT}"],"domainSocket":"${harperDataDir}/operations-server"}},"mqtt":{"network":{"port":null},"webSocket":false},"localStudio":{"enabled":false}}</string>
  </dict>
</dict>
</plist>
`;
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

function sshExec(
  tunnelVia: string,
  command: string,
  timeoutMs: number = 30_000,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("ssh", ["--", tunnelVia, command], {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: "pipe",
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    status: result.status,
  };
}

function scpSend(
  tunnelVia: string,
  localContent: string,
  remotePath: string,
  mode: string = "0644",
): void {
  // scp via stdin pipe — content never touches a local temp file
  const result = spawnSync(
    "ssh",
    ["--", tunnelVia, `cat > "${remotePath}" && chmod ${mode} "${remotePath}"`],
    {
      input: localContent,
      encoding: "utf-8",
      timeout: 15_000,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to write ${remotePath} on ${tunnelVia}: ${result.stderr || result.status}`
    );
  }
}

// ─── Remote operations ────────────────────────────────────────────────────────

/**
 * Check if Flair is already installed on the remote branch.
 * Heuristic: look for ~/.flair/node_modules/harper/ or a running systemd/launchd unit.
 */
export function flairSpokeExists(
  tunnelVia: string,
  name: string,
  os?: BranchOS,
): boolean {
  // Check for the flair directory
  const check = sshExec(tunnelVia, 'test -d ~/.flair/node_modules/harper && echo YES || echo NO');
  if (check.stdout === "YES") return true;

  // Check for systemd/launchd unit
  const actualOs = os ?? detectBranchOS(tunnelVia);
  if (actualOs === "linux") {
    const unit = sshExec(tunnelVia, `systemctl --user is-enabled tps-flair-${name}.service 2>/dev/null || echo NOT_FOUND`);
    if (unit.stdout.trim() !== "NOT_FOUND") return true;
  }

  return false;
}

/**
 * Install Flair (Harper) on the remote branch.
 *
 * Steps:
 *   1. Create ~/.flair and npm install @tpsdev-ai/flair
 *   2. Generate admin-pass via openssl, scp to ~/.flair/admin-pass (0600)
 *   3. Install Harper as a systemd service (Linux) or launchd plist (macOS)
 *   4. Update the supervision manifest with Flair state
 *
 * Returns the Flair install state for the caller to display/report.
 */
export function installFlairSpoke(
  tunnelVia: string,
  name: string,
  plan: FlairPlan,
  home?: string,
): FlairInstallState {
  const h = home ?? homedir();
  const flairDirRemote = "~/.flair";
  const harperDataDirRemote = "~/.harper/flair";
  const installedAt = new Date().toISOString();

  // --- 1. Create ~/.flair and install @tpsdev-ai/flair ---
  console.log(`   📦 Installing @tpsdev-ai/flair on ${tunnelVia}...`);
  const installResult = sshExec(
    tunnelVia,
    `mkdir -p ${flairDirRemote} && cd ${flairDirRemote} && npm install @tpsdev-ai/flair 2>&1`,
    120_000, // npm install can take a while
  );
  if (installResult.status !== 0) {
    const errMsg = installResult.stderr || installResult.stdout || `exit ${installResult.status}`;
    throw new Error(`npm install failed on ${tunnelVia}: ${errMsg}`);
  }
  console.log("   ✅ Flair package installed");

  // --- 2. Generate admin-pass ---
  // Generate locally (never echoed to stdout), pipe via ssh to remote
  console.log(`   🔑 Generating admin pass...`);
  const adminPass = execSync("openssl rand -base64 24", {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  scpSend(tunnelVia, adminPass + "\n", `${flairDirRemote}/admin-pass`, "0600");
  console.log("   ✅ Admin pass stored");

  // --- 3. Detect OS and install service ---
  const os = detectBranchOS(tunnelVia);
  console.log(`   🖥  Detected OS: ${os}`);

  if (os === "linux") {
    // Systemd path
    const unitName = `tps-flair-${name}`;
    const unitPath = `~/.config/systemd/user/${unitName}.service`;
    const unitContent = generateSystemdFlairUnit(
      unitName,
      flairDirRemote,
      harperDataDirRemote,
      DEFAULT_FLAIR_PORT,
    );

    // Write the unit file remotely
    scpSend(tunnelVia, unitContent, unitPath, "0644");

    // systemctl --user enable + start
    const enable = sshExec(
      tunnelVia,
      `systemctl --user daemon-reload && systemctl --user enable ${unitName}.service && systemctl --user start ${unitName}.service 2>&1`,
      15_000,
    );
    if (enable.status !== 0) {
      const err = enable.stderr || enable.stdout || `exit ${enable.status}`;
      throw new Error(`systemd enable/start failed on ${tunnelVia}: ${err}`);
    }
    console.log(`   ✅ Systemd unit enabled: ${unitName}`);

    // --- 4. Update supervision manifest ---
    const state: FlairInstallState = {
      flairDir: flairDirRemote,
      port: DEFAULT_FLAIR_PORT,
      adminPassPath: `${flairDirRemote}/admin-pass`,
      unitName,
      os: "linux",
      installedAt,
    };
    mergeFlairIntoManifest(name, state, h);

    return state;
  }

  if (os === "macos") {
    // Launchd path
    const label = `ai.tpsdev.flair-${name}`;
    const plistContent = generateLaunchdFlairPlist(
      label,
      flairDirRemote,
      harperDataDirRemote,
      homedir(), // remote's home
      DEFAULT_FLAIR_PORT,
    );
    const plistPath = `~/Library/LaunchAgents/${label}.plist`;

    // Write plist remotely
    scpSend(tunnelVia, plistContent, plistPath, "0644");

    // launchctl load
    const load = sshExec(
      tunnelVia,
      `launchctl unload "${plistPath}" 2>/dev/null || true; launchctl load "${plistPath}" 2>&1`,
      10_000,
    );
    if (load.status !== 0) {
      const err = load.stderr || load.stdout || `exit ${load.status}`;
      throw new Error(`launchctl load failed on ${tunnelVia}: ${err}`);
    }
    console.log(`   ✅ Launchd plist loaded: ${label}`);

    // --- 4. Update supervision manifest ---
    const state: FlairInstallState = {
      flairDir: flairDirRemote,
      port: DEFAULT_FLAIR_PORT,
      adminPassPath: `${flairDirRemote}/admin-pass`,
      unitName: label,
      os: "macos",
      installedAt,
    };
    mergeFlairIntoManifest(name, state, h);

    return state;
  }

  throw new Error(
    `Unsupported OS on ${tunnelVia}: ${os}. Only Linux (systemd) and macOS (launchd) are supported.`
  );
}

/**
 * Configure fed-sync from the branch spoke to the team hub.
 *
 * Steps:
 *   1. Write a sync config on the remote (~/.tps/flair-sync.json)
 *   2. Install systemd timer + service for periodic sync (or launchd for macOS)
 *   3. Run a one-shot sync to validate the initial pair
 *
 * Called only in spoke mode (hub + auth both set).
 */
export function configureFederation(
  tunnelVia: string,
  name: string,
  plan: FlairPlan,
  home?: string,
): FedSyncState {
  if (!plan.hub || !plan.auth) {
    throw new Error("Cannot configure federation without hub and auth");
  }
  const h = home ?? homedir();
  const installedAt = new Date().toISOString();
  const syncConfigRemote = "~/.tps/flair-sync.json";
  const intervalSec = 300; // 5 minutes

  const os = detectBranchOS(tunnelVia);

  // --- 1. Write sync config on the remote ---
  console.log(`   🔗 Configuring fed-sync spoke→hub...`);

  // Read the hub auth file locally to get the token
  const hubAuth = readFileSync(plan.auth.path, "utf-8").trim();

  // Build sync config
  const syncConfig = JSON.stringify(
    {
      localUrl: `http://127.0.0.1:${DEFAULT_FLAIR_PORT}`,
      remoteUrl: plan.hub,
      agentId: name,
      remoteAuth: hubAuth,
      lastSyncTimestamp: new Date(0).toISOString(),
      direction: "push", // spoke→hub
    },
    null,
    2,
  );

  scpSend(tunnelVia, syncConfig + "\n", syncConfigRemote, "0600");
  console.log("   ✅ Sync config written");

  // --- 2. Install fed-sync timer + service ---
  if (os === "linux") {
    const serviceName = `tps-fed-sync-${name}`;
    const timerName = `tps-fed-sync-${name}`;

    const serviceUnit = generateFedSyncService(serviceName, syncConfigRemote);
    const timerUnit = generateFedSyncTimer(timerName, serviceName, intervalSec);

    scpSend(tunnelVia, serviceUnit, `~/.config/systemd/user/${serviceName}.service`, "0644");
    scpSend(tunnelVia, timerUnit, `~/.config/systemd/user/${timerName}.timer`, "0644");

    // Enable and start the timer (not the service — timer triggers it)
    const enable = sshExec(
      tunnelVia,
      `systemctl --user daemon-reload && systemctl --user enable ${timerName}.timer && systemctl --user start ${timerName}.timer 2>&1`,
      15_000,
    );
    if (enable.status !== 0) {
      const err = enable.stderr || enable.stdout || `exit ${enable.status}`;
      throw new Error(`fed-sync systemd enable failed: ${err}`);
    }
    console.log("   ✅ Fed-sync timer enabled");

    // --- 3. One-shot sync to validate ---
    console.log("   🔄 Running initial sync...");
    const initialSync = sshExec(
      tunnelVia,
      `TPS_FLAIR_SYNC_CONFIG="${syncConfigRemote}" bun run ~/ops/tps/packages/cli/dist/bin/tps.js flair sync --once 2>&1`,
      60_000,
    );

    let lastSync: string | null = null;
    if (initialSync.status === 0) {
      lastSync = new Date().toISOString();
      console.log("   ✅ Initial sync succeeded");
    } else {
      console.log(
        `   ⚠️  Fed-sync failed — branch is hub-less until fixed\n` +
          `   ${initialSync.stderr || initialSync.stdout || "unknown error"}`
      );
    }

    // --- 4. Update supervision manifest ---
    const fedState: FedSyncState = {
      serviceName,
      timerName,
      syncConfigPath: syncConfigRemote,
      hub: plan.hub,
      intervalSeconds: intervalSec,
      lastSync,
      installedAt,
    };
    mergeFedSyncIntoManifest(name, fedState, h);

    return fedState;
  }

  // macOS: Not yet implemented — spec says to emit launchd job.
  // For now, document that macOS branches get Flair installed but fed-sync
  // requires a follow-up setup.
  console.log("   ⚠️  Fed-sync on macOS branches is not yet automated.");
  console.log(`       Manual setup: configure ~/.tps/flair-sync.json and run tps flair sync --once`);

  const fedState: FedSyncState = {
    serviceName: `ai.tpsdev.fed-sync-${name}`,
    timerName: `ai.tpsdev.fed-sync-${name}`,
    syncConfigPath: syncConfigRemote,
    hub: plan.hub,
    intervalSeconds: intervalSec,
    lastSync: null,
    installedAt,
  };
  mergeFedSyncIntoManifest(name, fedState, h);

  return fedState;
}

/**
 * Tear down Flair spoke + optional fed-sync on the remote branch.
 *
 * Steps:
 *   1. Stop + disable fed-sync timer/service (if present)
 *   2. Stop + disable Flair systemd unit (or unload launchd plist)
 *   3. Optionally --purge-flair: rm -rf ~/.flair and ~/.harper/flair
 *   4. Update supervision manifest to remove flair fields
 */
export function teardownFlairSpoke(
  tunnelVia: string,
  name: string,
  opts: { purgeFlair?: boolean; home?: string } = {},
): void {
  const h = opts.home ?? homedir();
  const sup = readSupervision(name, h);
  if (!sup) return;

  const ext = sup as ExtendedSupervisionManifest;

  // --- 1. Stop fed-sync units ---
  if (ext.fedSync) {
    const fs = ext.fedSync;
    console.log(`   🛑 Stopping fed-sync: ${fs.timerName}`);
    sshExec(
      tunnelVia,
      `systemctl --user stop ${fs.timerName}.timer 2>/dev/null || true; systemctl --user disable ${fs.timerName}.timer 2>/dev/null || true`,
      10_000,
    );
    // Remove unit files
    sshExec(
      tunnelVia,
      `rm -f ~/.config/systemd/user/${fs.timerName}.timer ~/.config/systemd/user/${fs.serviceName}.service 2>/dev/null || true`,
      10_000,
    );
    // Remove sync config
    sshExec(tunnelVia, `rm -f ${fs.syncConfigPath} 2>/dev/null || true`, 10_000);
    console.log("   ✅ Fed-sync units removed");
  }

  // --- 2. Stop Flair unit ---
  if (ext.flair) {
    const f = ext.flair;
    if (f.os === "linux") {
      console.log(`   🛑 Stopping Flair: ${f.unitName}`);
      sshExec(
        tunnelVia,
        `systemctl --user stop ${f.unitName}.service 2>/dev/null || true; systemctl --user disable ${f.unitName}.service 2>/dev/null || true`,
        10_000,
      );
      // Remove unit file
      sshExec(
        tunnelVia,
        `rm -f ~/.config/systemd/user/${f.unitName}.service 2>/dev/null || true`,
        10_000,
      );
      sshExec(tunnelVia, `systemctl --user daemon-reload 2>/dev/null || true`, 10_000);
    } else if (f.os === "macos") {
      const plistPath = `~/Library/LaunchAgents/${f.unitName}.plist`;
      sshExec(tunnelVia, `launchctl unload "${plistPath}" 2>/dev/null || true`, 10_000);
      sshExec(tunnelVia, `rm -f "${plistPath}" 2>/dev/null || true`, 10_000);
    }
    console.log("   ✅ Flair unit removed");

    // --- 3. Optionally purge data ---
    if (opts.purgeFlair) {
      console.log("   🗑  Purging Flair data...");
      sshExec(tunnelVia, `rm -rf ~/.flair ~/.harper/flair 2>/dev/null || true`, 15_000);
      console.log("   ✅ Flair data purged");
    }
  }

  // --- 4. Clear Flair fields from manifest ---
  try {
    const clean: SupervisionManifest = {
      tunnel: sup.tunnel,
      office: sup.office,
      installedAt: sup.installedAt,
    };
    writeSupervision(name, clean, h);
  } catch {
    // Best-effort — manifest is non-critical after teardown
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Probe the remote branch for Flair spoke health.
 * Returns best-effort report; all errors are caught and reflected in the struct.
 */
export function checkFlairHealth(
  tunnelVia: string,
  name: string,
  home?: string,
): FlairHealthReport {
  const report: FlairHealthReport = {
    installed: false,
    unitActive: false,
    port: DEFAULT_FLAIR_PORT,
    flairDir: "~/.flair",
    apiReachable: false,
    fedSyncConfigured: false,
    fedSyncActive: false,
    lastFedSync: null,
  };

  try {
    const sup = readSupervision(name, home) as ExtendedSupervisionManifest | null;
    if (!sup?.flair) return report;

    const f = sup.flair;
    report.installed = true;
    report.port = f.port;
    report.flairDir = f.flairDir;

    // Check unit status
    if (f.os === "linux") {
      const status = sshExec(
        tunnelVia,
        `systemctl --user is-active ${f.unitName}.service 2>/dev/null || echo inactive`,
        5_000,
      );
      report.unitActive = status.stdout.trim() === "active";
    } else if (f.os === "macos") {
      const status = sshExec(
        tunnelVia,
        `launchctl list ${f.unitName} 2>/dev/null || echo NOT_FOUND`,
        5_000,
      );
      report.unitActive = status.status === 0 && !status.stdout.includes("NOT_FOUND");
    }

    // Probe Flair API
    try {
      const api = sshExec(
        tunnelVia,
        `curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:${f.port}/Health/0" 2>/dev/null || echo 000`,
        5_000,
      );
      report.apiReachable = api.stdout.trim() === "200";
    } catch {
      // unreachable
    }

    // Fed-sync
    if (sup.fedSync) {
      const fs = sup.fedSync;
      report.fedSyncConfigured = true;
      report.lastFedSync = fs.lastSync;

      if (f.os === "linux") {
        const timerStatus = sshExec(
          tunnelVia,
          `systemctl --user is-active ${fs.timerName}.timer 2>/dev/null || echo inactive`,
          5_000,
        );
        report.fedSyncActive = timerStatus.stdout.trim() === "active";
      }
    }
  } catch {
    // Best-effort — report defaults are fine
  }

  return report;
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

function mergeFlairIntoManifest(
  name: string,
  flair: FlairInstallState,
  home: string,
): void {
  const existing = readSupervision(name, home) as ExtendedSupervisionManifest | null;
  if (!existing) return; // shouldn't happen — supervision must exist before flair install

  const merged: ExtendedSupervisionManifest = {
    tunnel: existing.tunnel,
    office: existing.office,
    installedAt: existing.installedAt,
    flair,
    fedSync: (existing as ExtendedSupervisionManifest).fedSync,
  };
  writeSupervision(name, merged, home);
}

function mergeFedSyncIntoManifest(
  name: string,
  fedSync: FedSyncState,
  home: string,
): void {
  const existing = readSupervision(name, home) as ExtendedSupervisionManifest | null;
  if (!existing) return;

  const merged: ExtendedSupervisionManifest = {
    tunnel: existing.tunnel,
    office: existing.office,
    installedAt: existing.installedAt,
    flair: (existing as ExtendedSupervisionManifest).flair,
    fedSync,
  };
  writeSupervision(name, merged, home);
}
