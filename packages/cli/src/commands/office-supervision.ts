/**
 * ops-7x9y: launchd supervision for `tps office join --tunnel-via`.
 *
 * Generates and manages macOS launchd plists that keep SSH tunnels and
 * office-connect processes alive across reboots. Each branch-office gets
 * two units:
 *   - ai.tpsdev.tunnel-<name>: autossh-style port forward
 *   - ai.tpsdev.office-<name>: persistent office connect
 *
 * All state is tracked in ~/.tps/branch-office/<name>/supervision.json.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- Port scanning ----

const PORT_RANGE_START = 33700;
const PORT_RANGE_END = 33999;

/**
 * Find the first unused local TCP port in the deterministic range 33700–33999.
 * A port is considered "taken" if a launchd plist in ~/Library/LaunchAgents
 * references it in a -L argument.
 */
export function findFreeLaunchdPort(home: string = homedir()): number {
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const taken = new Set<number>();

  if (existsSync(launchAgentsDir)) {
    const { readdirSync } = require("node:fs");
    for (const f of readdirSync(launchAgentsDir)) {
      if (!f.endsWith(".plist")) continue;
      try {
        const content = readFileSync(join(launchAgentsDir, f), "utf-8");
        // Match -L <port>:127.0.0.1:<port> or -L <port>:localhost:<port>
        const re = /<string>-L<\/string>\s*<string>(\d+):/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          taken.add(parseInt(m[1], 10));
        }
      } catch {
        // unreadable plist → skip
      }
    }
  }

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!taken.has(port)) return port;
  }

  throw new Error(
    `No free port found in range ${PORT_RANGE_START}–${PORT_RANGE_END}. ` +
      `Free up a port or use --port to choose manually.`
  );
}

// ---- Plist generation ----

function resolveBun(): string {
  try {
    return execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    return "/opt/homebrew/bin/bun";
  }
}

function resolveSsh(): string {
  try {
    return execSync("which ssh", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/bin/ssh";
  }
}

export interface TunnelPlistParams {
  name: string;
  localPort: number;
  tunnelVia: string;
  home?: string;
}

export function generateTunnelPlist(params: TunnelPlistParams): string {
  const home = params.home ?? homedir();
  const label = `ai.tpsdev.tunnel-${params.name}`;
  const ssh = resolveSsh();
  const logDir = join(home, ".tps", "logs");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${ssh}</string>
    <string>-N</string>
    <string>-L</string>
    <string>${params.localPort}:127.0.0.1:${params.localPort}</string>
    <string>${params.tunnelVia}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${join(logDir, `tunnel-${params.name}.log`)}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, `tunnel-${params.name}.error.log`)}</string>
</dict>
</plist>
`;
}

export interface OfficePlistParams {
  name: string;
  home?: string;
}

export function generateOfficePlist(params: OfficePlistParams): string {
  const home = params.home ?? homedir();
  const label = `ai.tpsdev.office-${params.name}`;
  const bun = resolveBun();
  const tpsJs = join(home, "ops/tps/packages/cli/dist/bin/tps.js");
  const logDir = join(home, ".tps", "logs");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>run</string>
    <string>${tpsJs}</string>
    <string>office</string>
    <string>connect</string>
    <string>${params.name}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${join(home, "ops/tps")}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${join(logDir, `office-${params.name}.log`)}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, `office-${params.name}.error.log`)}</string>
</dict>
</plist>
`;
}

// ---- Atomic plist writes ----

function plistPath(label: string, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function writePlist(label: string, content: string, home?: string): string {
  const h = home ?? homedir();
  const dest = plistPath(label, h);
  const tmp = dest + ".tmp";

  mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
  renameSync(tmp, dest);
  return dest;
}

export function deletePlist(label: string, home?: string): void {
  const dest = plistPath(label, home);
  if (existsSync(dest)) {
    unlinkSync(dest);
  }
}

// ---- launchctl helpers ----

function isUnitLoaded(label: string): boolean {
  try {
    execSync(`launchctl list "${label}" 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    return true;
  } catch {
    return false;
  }
}

export function loadUnit(plistPath: string): void {
  execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
}

export function unloadUnit(plistPath: string, label: string): void {
  // Try to unload; if it's already gone that's fine
  try {
    if (isUnitLoaded(label)) {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, {
        stdio: "pipe",
      });
    }
  } catch {
    // Best-effort
  }
}

export interface UnitState {
  label: string;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

export function getUnitState(label: string): UnitState {
  const state: UnitState = { label, loaded: false, pid: null, lastExitStatus: null };
  try {
    // `launchctl list <label>` outputs "PID\tSTATUS\tLABEL" or just "-"
    const out = execSync(`launchctl list "${label}" 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    if (!out) return state; // not loaded

    state.loaded = true;
    const parts = out.split(/\s+/);
    const pidStr = parts[0];
    if (pidStr && pidStr !== "-") {
      state.pid = parseInt(pidStr, 10);
    }
    if (parts.length >= 2 && parts[1] !== "-") {
      state.lastExitStatus = parseInt(parts[1], 10);
    }
  } catch {
    // best-effort
  }

  // Also try the richer `launchctl print` format
  if (state.loaded) {
    try {
      const detail = execSync(`launchctl print "user/$(id -u)/${label}" 2>/dev/null || true`, {
        encoding: "utf-8",
        shell: "/bin/sh",
      });
      const pidMatch = detail.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) state.pid = parseInt(pidMatch[1], 10);
    } catch {
      // fall through
    }
  }

  return state;
}

// ---- Supervision manifest ----

export interface SupervisionManifest {
  tunnel: {
    plistLabel: string;
    plistPath: string;
    localPort: number;
    tunnelVia: string;
  };
  office: {
    plistLabel: string;
    plistPath: string;
  };
  installedAt: string;
}

function supervisionDir(name: string, home?: string): string {
  return join(home ?? homedir(), ".tps", "branch-office", name);
}

function supervisionPath(name: string, home?: string): string {
  return join(supervisionDir(name, home), "supervision.json");
}

export function supervisionExists(name: string, home?: string): boolean {
  return existsSync(supervisionPath(name, home));
}

export function readSupervision(name: string, home?: string): SupervisionManifest | null {
  const p = supervisionPath(name, home);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  // Basic validation
  if (!raw.tunnel || !raw.office || !raw.installedAt) return null;
  return raw as SupervisionManifest;
}

export function writeSupervision(
  name: string,
  manifest: SupervisionManifest,
  home?: string
): string {
  const dir = supervisionDir(name, home);
  mkdirSync(dir, { recursive: true });
  const p = supervisionPath(name, home);
  // mode 0644 — no secrets
  writeFileSync(p, JSON.stringify(manifest, null, 2), { encoding: "utf-8", mode: 0o644 });
  return p;
}

export function deleteSupervision(name: string, home?: string): void {
  const p = supervisionPath(name, home);
  if (existsSync(p)) unlinkSync(p);
}

// ---- SSH validation ----

export function validateSshReachable(host: string): void {
  // Test with a simple `ssh <host> exit 0` — the actual reachability check.
  const result = spawnSync("ssh", [host, "exit", "0"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(
      `SSH reachability check failed: ssh ${host} exit 0\n` +
        (stderr ? `  ${stderr}` : `  exit code ${result.status}`)
    );
  }
}

// ---- Full install / teardown ----

export interface InstallResult {
  localPort: number;
  tunnelLabel: string;
  officeLabel: string;
  manifest: SupervisionManifest;
}

export function installSupervision(
  name: string,
  tunnelVia: string,
  portOverride?: number,
  home?: string
): InstallResult {
  const h = home ?? homedir();
  const logDir = join(h, ".tps", "logs");
  mkdirSync(logDir, { recursive: true });

  // Validate SSH reachability
  validateSshReachable(tunnelVia);

  // Auto-pick or use override
  const localPort = portOverride ?? findFreeLaunchdPort(h);

  // Generate plists
  const tunnelLabel = `ai.tpsdev.tunnel-${name}`;
  const officeLabel = `ai.tpsdev.office-${name}`;

  const tunnelContent = generateTunnelPlist({ name, localPort, tunnelVia, home: h });
  const officeContent = generateOfficePlist({ name, home: h });

  // Atomic write
  const tunnelPath = writePlist(tunnelLabel, tunnelContent, h);
  const officePath = writePlist(officeLabel, officeContent, h);

  // Load both
  loadUnit(tunnelPath);
  loadUnit(officePath);

  // Persist manifest
  const manifest: SupervisionManifest = {
    tunnel: {
      plistLabel: tunnelLabel,
      plistPath: tunnelPath,
      localPort,
      tunnelVia,
    },
    office: {
      plistLabel: officeLabel,
      plistPath: officePath,
    },
    installedAt: new Date().toISOString(),
  };

  writeSupervision(name, manifest, h);

  return { localPort, tunnelLabel, officeLabel, manifest };
}

export function teardownSupervision(
  name: string,
  home?: string
): { tunnelLabel: string; officeLabel: string } | null {
  const manifest = readSupervision(name, home);
  if (!manifest) return null;

  const { tunnel, office } = manifest;

  // Unload
  unloadUnit(tunnel.plistPath, tunnel.plistLabel);
  unloadUnit(office.plistPath, office.plistLabel);

  // Delete plists
  deletePlist(tunnel.plistLabel, home);
  deletePlist(office.plistLabel, home);

  // Delete manifest
  deleteSupervision(name, home);

  return { tunnelLabel: tunnel.plistLabel, officeLabel: office.plistLabel };
}
