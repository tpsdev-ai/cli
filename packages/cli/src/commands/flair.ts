/**
 * tps harper install|uninstall|start|stop|restart|status|logs
 *
 * Manages Harper (Flair backend) as a macOS launchd agent.
 * Auto-restarts on crash, starts on login.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const PLIST_LABEL = "ai.tpsdev.flair";
const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const LOG_DIR = join(homedir(), ".tps/logs");
const STDOUT_LOG = join(LOG_DIR, "flair.log");
const STDERR_LOG = join(LOG_DIR, "flair.error.log");

interface HarperOpts {
  flairDir?: string;
  dev?: boolean;
}

function getFlairDir(opts: HarperOpts): string {
  const dir =
    opts.flairDir ??
    process.env.FLAIR_DIR ??
    join(homedir(), "ops/flair");
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    throw new Error(
      `Flair directory not found: ${resolved}\n` +
        `Set --flair-dir or FLAIR_DIR env var.`,
    );
  }
  return resolved;
}

const SECRETS_DIR = join(homedir(), ".tps/secrets/flair");
const ADMIN_TOKEN_PATH = join(SECRETS_DIR, "harper-admin-token");

function ensureAdminToken(): string {
  mkdirSync(SECRETS_DIR, { recursive: true });
  if (existsSync(ADMIN_TOKEN_PATH)) {
    return readFileSync(ADMIN_TOKEN_PATH, "utf8").trim();
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(ADMIN_TOKEN_PATH, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf8" }).trim();
  } catch {
    return "/opt/homebrew/bin/node";
  }
}

function buildPlist(flairDir: string, dev: boolean, harperDataDir: string, adminToken: string): string {
  const nodePath = getNodePath();
  const harperBin = join(flairDir, "node_modules/harperdb/bin/harper.js");
  const mode = "dev";  // Harper "run" requires pre-installed instance; dev works for all setups

  if (!existsSync(harperBin)) {
    throw new Error(
      `Harper binary not found: ${harperBin}\n` +
        `Run: cd ${flairDir} && npm install`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${harperBin}</string>
    <string>${mode}</string>
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
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>HARPER_SET_CONFIG</key>
    <string>{"rootPath":"${harperDataDir}","http":{"port":9926},"operationsApi":{"network":{"port":9925}},"authentication":{"operationsAdminPassword":"${adminToken}"}}</string>

  <key>FLAIR_ADMIN_TOKEN</key>
  <string>${adminToken}</string>
  </dict>
</dict>
</plist>
`;
}

function isLoaded(): boolean {
  try {
    const out = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null || true`, {
      encoding: "utf8",
    }).trim();
    return out.length > 0 && !out.startsWith("Could not find");
  } catch {
    return false;
  }
}

function getPid(): number | null {
  try {
    const out = execSync(
      `launchctl list ${PLIST_LABEL} 2>/dev/null || true`,
      { encoding: "utf8" },
    );
    const match = out.match(/"PID"\s*=\s*(\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch {
    return null;
  }
}

function isHarperResponding(): boolean {
  try {
    execSync("curl -sf -o /dev/null http://127.0.0.1:9925/health", {
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function flairCommand(
  action: string,
  opts: HarperOpts,
): Promise<void> {
  switch (action) {
    case "install": {
      const flairDir = getFlairDir(opts);
      mkdirSync(LOG_DIR, { recursive: true });
      const harperDataDir = join(homedir(), ".harper/flair");
      mkdirSync(harperDataDir, { recursive: true });
      const adminToken = ensureAdminToken();
      const plist = buildPlist(flairDir, opts.dev ?? false, harperDataDir, adminToken);
      writeFileSync(PLIST_PATH, plist, "utf8");
      chmodSync(PLIST_PATH, 0o644);
      if (isLoaded()) {
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`, {
          stdio: "pipe",
        });
      }
      execSync(`launchctl load "${PLIST_PATH}"`);
      console.log(`✅ Flair launchd agent installed and started`);
      console.log(`   Plist: ${PLIST_PATH}`);
      console.log(`   Logs:  ${STDOUT_LOG}`);
      console.log(`   Flair: ${flairDir}`);
      console.log(`   Token: ${ADMIN_TOKEN_PATH}`);
      console.log(`   Mode:  dev`);
      // Update Harper's internal admin password (stored in DB, HARPER_SET_CONFIG only sets on first install).
      // Poll until Harper is up (up to 30s), then rotate.
      await new Promise<void>((resolve) => setTimeout(resolve, 12000));
      try {
        for (const oldPw of ["admin123", adminToken]) {
          const cred = "Basic " + Buffer.from(`admin:${oldPw}`).toString("base64");
          const res = await fetch("http://127.0.0.1:9925", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: cred },
            body: JSON.stringify({ operation: "alter_user", role: "super_user", username: "admin", password: adminToken }),
          });
          if (res.ok) { console.log("   ✅ Admin password rotated"); break; }
        }
      } catch (err: any) {
        console.warn(`   ⚠️  Could not rotate password yet. Run 'tps flair install' again once Flair is up.`);
      }
      break;
    }
    case "uninstall": {
      if (isLoaded()) {
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`, {
          stdio: "pipe",
        });
      }
      if (existsSync(PLIST_PATH)) {
        execSync(`rm "${PLIST_PATH}"`);
        console.log(`✅ Harper launchd agent uninstalled`);
      } else {
        console.log(`Nothing to uninstall (plist not found)`);
      }
      break;
    }
    case "start": {
      if (!existsSync(PLIST_PATH)) {
        console.error(`❌ Not installed. Run: tps flair install --flair-dir <path>`);
        process.exit(1);
      }
      if (isLoaded()) {
        execSync(`launchctl kickstart -k "user/$(id -u)/${PLIST_LABEL}"`, { shell: "/bin/sh", stdio: "pipe" } as any);
      } else {
        execSync(`launchctl load "${PLIST_PATH}"`);
      }
      console.log(`✅ Harper started`);
      break;
    }
    case "stop": {
      if (!isLoaded()) {
        console.log(`Harper is not running`);
        return;
      }
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`, {
        stdio: "pipe",
      });
      console.log(`✅ Harper stopped`);
      break;
    }
    case "restart": {
      if (!existsSync(PLIST_PATH)) {
        console.error(`❌ Not installed. Run: tps flair install`);
        process.exit(1);
      }
      if (isLoaded()) {
        execSync(`launchctl kickstart -k "user/$(id -u)/${PLIST_LABEL}"`, { shell: "/bin/sh", stdio: "pipe" } as any);
      } else {
        execSync(`launchctl load "${PLIST_PATH}"`);
      }
      console.log(`✅ Harper restarted`);
      break;
    }
    case "status": {
      const loaded = isLoaded();
      const pid = getPid();
      const responding = loaded ? isHarperResponding() : false;
      if (!existsSync(PLIST_PATH)) {
        console.log(`Flair launchd agent: NOT INSTALLED`);
        console.log(`  Run: tps flair install --flair-dir ~/ops/flair`);
      } else if (!loaded) {
        console.log(`Flair launchd agent: INSTALLED but NOT RUNNING`);
        console.log(`  Run: tps flair start`);
      } else {
        console.log(
          `Flair launchd agent: ${responding ? "✅ RUNNING" : "⚠️  LOADED (not responding)"}`,
        );
        if (pid) console.log(`  PID: ${pid}`);
        console.log(`  API:   http://127.0.0.1:9925`);
        console.log(`  Flair: http://127.0.0.1:9926`);
        console.log(`  Logs:  ${STDOUT_LOG}`);
      }
      if (existsSync(PLIST_PATH)) {
        const plistContent = readFileSync(PLIST_PATH, "utf8");
        const modeMatch = plistContent.match(/<string>(run|dev)<\/string>/);
        if (modeMatch) console.log(`  Mode:  ${modeMatch[1]}`);
      }
      break;
    }
    case "logs": {
      if (!existsSync(STDOUT_LOG)) {
        console.log(`No logs yet at ${STDOUT_LOG}`);
        return;
      }
      execSync(`tail -50 "${STDOUT_LOG}"`, { stdio: "inherit" });
      break;
    }
    default:
      console.error(
        `Unknown action: ${action}\nUsage: tps harper install|uninstall|start|stop|restart|status|logs`,
      );
      process.exit(1);
  }
}
