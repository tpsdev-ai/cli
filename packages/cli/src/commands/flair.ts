/**
 * tps flair install|uninstall|start|stop|restart|status|logs   (local lifecycle)
 * tps flair set-hub|clear-hub|show|probe                       (team config — ops-wn6g)
 *
 * Local lifecycle actions manage Harper (Flair backend) as a macOS launchd
 * agent. Auto-restarts on crash, starts on login.
 *
 * Config actions manage ~/.tps/flair.json so other TPS subcommands (and
 * future branch-init) know the team's Flair hub URL without scraping env
 * vars. Hub-less mode is valid: set-hub is optional; branches without a
 * configured hub get local Flair only (no fed-sync). See ops-wn6g.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const PLIST_LABEL = "ai.tpsdev.flair";
const HARPER_OPS_URL = "http://127.0.0.1:9925";  // local only, not a security risk
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
  // Config action args (set-hub / clear-hub / show / probe)
  hub?: string;
  authMode?: string;
  authPath?: string;
  port?: number;
  json?: boolean;
}

export interface FlairConfigFile {
  hub: string | null;
  auth: { mode: "admin-pass-file"; path: string } | null;
  localPort: number;
}

const DEFAULT_LOCAL_PORT = 9926;

function tpsRoot(): string {
  return process.env.TPS_ROOT || join(process.env.HOME || homedir(), ".tps");
}

function flairConfigPath(): string {
  return join(tpsRoot(), "flair.json");
}

export function readFlairConfigFile(): FlairConfigFile {
  const p = flairConfigPath();
  if (!existsSync(p)) {
    return { hub: null, auth: null, localPort: DEFAULT_LOCAL_PORT };
  }
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  return {
    hub: raw.hub ? String(raw.hub) : null,
    auth:
      raw.auth && raw.auth.mode === "admin-pass-file" && raw.auth.path
        ? { mode: "admin-pass-file", path: String(raw.auth.path) }
        : null,
    localPort: typeof raw.localPort === "number" ? raw.localPort : DEFAULT_LOCAL_PORT,
  };
}

/**
 * Strip user:pass@ userinfo from a URL for display. Returns the original
 * string unchanged if it isn't a parseable URL with userinfo. Used by
 * `tps flair show` so a previously-stored credential-bearing URL doesn't
 * leak via stdout. set-hub rejects credential URLs at write time;
 * this is defense-in-depth.
 */
export function redactUrlCredentials(input: string): string {
  try {
    const u = new URL(input);
    if (!u.username && !u.password) return input;
    u.username = "";
    u.password = "";
    // Re-encode without trailing colon-only userinfo block.
    return u.toString();
  } catch {
    return input;
  }
}

export function writeFlairConfigFile(config: FlairConfigFile): void {
  const p = flairConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic write: tmp + rename so a concurrent reader never sees a partial
  // file. Same pattern as cli#281 outbox fix.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, p);
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

function buildPlist(flairDir: string, _dev: boolean, harperDataDir: string): string {
  const nodePath = getNodePath();
  // Support both new (harper package) and old (harperdb package) binary paths
  const harperBinNew = join(flairDir, "node_modules/harper/dist/bin/harper.js");
  const harperBinOld = join(flairDir, "node_modules/harperdb/bin/harper.js");
  const harperBin = existsSync(harperBinNew) ? harperBinNew : harperBinOld;
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
    <string>{"rootPath":"${harperDataDir}","http":{"port":9926,"cors":true,"corsAccessList":["http://127.0.0.1:9926","http://localhost:9926"]},"operationsApi":{"network":{"port":9925,"cors":true,"corsAccessList":["http://127.0.0.1:9925","http://localhost:9925"],"domainSocket":"${harperDataDir}/operations-server"}},"mqtt":{"network":{"port":null},"webSocket":false},"localStudio":{"enabled":false}}</string>
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
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function isHarperResponding(): boolean {
  try {
    execSync(`curl -sf -o /dev/null ${HARPER_OPS_URL}/health`, {
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
      const plist = buildPlist(flairDir, opts.dev ?? false, harperDataDir);
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
        // Use Harper's Unix domain socket to avoid HTTP-over-loopback for admin ops.
        const harperSocket = join(harperDataDir, "operations-server");
        for (const oldPw of ["admin123", adminToken]) {
          const cred = `Basic ${Buffer.from(`admin:${oldPw}`).toString("base64")}`;
          const body = JSON.stringify({ operation: "alter_user", role: "super_user", username: "admin", password: adminToken });
          try {
            execSync(
              `curl -sf --unix-socket "${harperSocket}" http://localhost` +
              ` -X POST -H 'Content-Type: application/json'` +
              ` -H 'Authorization: ${cred}'` +
              ` -d '${body}'`,
              { stdio: "pipe" }
            );
            console.log("   ✅ Admin password rotated (via Unix socket)");
            break;
          } catch { }
        }
      } catch (_err: any) {
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

    // -- Config actions (ops-wn6g) ---------------------------------------

    case "set-hub": {
      if (!opts.hub) {
        console.error(
          "Usage: tps flair set-hub <url> [--auth-mode admin-pass-file --auth-path <path>] [--port <n>]",
        );
        process.exit(1);
      }
      const trimmed = opts.hub.trim();
      if (trimmed === "") {
        console.error("Empty URL not allowed. Use `tps flair clear-hub` to remove the hub.");
        process.exit(1);
      }
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        console.error(`Invalid URL: ${opts.hub}`);
        process.exit(1);
      }
      // Allowlist protocols. set-hub points the team's Flair config at an HTTP
      // endpoint — accepting non-HTTP schemes (file, ftp, websocket, etc.)
      // would let a typo write something the probe action then tries to fetch
      // with unexpected semantics. Kern nit (PR #284 review).
      if (!["https:", "http:"].includes(parsed.protocol)) {
        console.error(
          `Unsupported protocol: ${parsed.protocol}. Hub must be https:// or http://.`,
        );
        process.exit(1);
      }
      // Reject embedded credentials. set-hub should not store `https://user:pass@host`
      // — credentials belong in --auth-mode/--auth-path. Sherlock nit (PR #284
      // review): URLs with userinfo leak via `tps flair show` output and shell
      // history. Refuse at write time; downstream `show` also redacts as
      // defense-in-depth (forward-compat for already-stored configs).
      if (parsed.username || parsed.password) {
        console.error(
          "URL contains embedded credentials. Use --auth-mode + --auth-path instead; the hub URL should not carry user:pass@host.",
        );
        process.exit(1);
      }
      // Bounds-check the local port if provided.
      if (typeof opts.port === "number") {
        if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
          console.error(`Invalid --port: ${opts.port}. Must be an integer in 1..65535.`);
          process.exit(1);
        }
      }
      const existing = readFlairConfigFile();
      const config: FlairConfigFile = {
        hub: trimmed,
        auth:
          opts.authMode === "admin-pass-file" && opts.authPath
            ? { mode: "admin-pass-file", path: opts.authPath }
            : existing.auth,
        localPort: typeof opts.port === "number" ? opts.port : existing.localPort,
      };
      writeFlairConfigFile(config);
      console.log(`Flair hub set: ${config.hub}`);
      if (config.auth) {
        console.log(`Auth: ${config.auth.mode} at ${config.auth.path}`);
      } else {
        console.log("Auth: none configured (set with --auth-mode + --auth-path)");
      }
      break;
    }

    case "clear-hub": {
      if (!existsSync(flairConfigPath())) {
        console.log("No Flair config to clear.");
        return;
      }
      const existing = readFlairConfigFile();
      writeFlairConfigFile({ hub: null, auth: null, localPort: existing.localPort });
      console.log("Flair hub cleared. Branches will provision in hub-less mode (no fed-sync).");
      break;
    }

    case "show": {
      const config = readFlairConfigFile();
      // Defense-in-depth: even though set-hub rejects URLs with embedded
      // credentials, an already-stored config (from a pre-fix version or
      // hand-edited flair.json) could contain user:pass@host. Redact before
      // any output reaches stdout / shell history / screen scrollback.
      // Sherlock nit (PR #284 review).
      const hubDisplay = config.hub ? redactUrlCredentials(config.hub) : null;
      const safe = {
        hub: hubDisplay,
        auth: config.auth ? { mode: config.auth.mode, path: config.auth.path } : null,
        localPort: config.localPort,
      };
      if (opts.json) {
        console.log(JSON.stringify(safe, null, 2));
      } else {
        console.log(`Hub:        ${hubDisplay ?? "(none — hub-less mode)"}`);
        console.log(
          `Auth:       ${config.auth ? `${config.auth.mode} at ${config.auth.path}` : "(none)"}`,
        );
        console.log(`Local port: ${config.localPort}`);
      }
      break;
    }

    case "probe": {
      const config = readFlairConfigFile();
      const results: Record<string, unknown> = {
        config: { hub: config.hub, localPort: config.localPort },
        localFlair: null,
        hubReachable: null,
      };
      try {
        const res = await fetch(`http://127.0.0.1:${config.localPort}/Health/0`, {
          signal: AbortSignal.timeout(2_000),
        });
        results.localFlair = { ok: res.ok, status: res.status };
      } catch (err) {
        results.localFlair = { ok: false, error: (err as Error).message };
      }
      if (config.hub) {
        try {
          const u = new URL(config.hub);
          const probeUrl = `${u.protocol}//${u.host}/Health/0`;
          const res = await fetch(probeUrl, { signal: AbortSignal.timeout(5_000) });
          results.hubReachable = { ok: res.ok, status: res.status };
        } catch (err) {
          results.hubReachable = { ok: false, error: (err as Error).message };
        }
      }
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`Hub:         ${config.hub ?? "(none)"}`);
        const local = results.localFlair as { ok: boolean; status?: number; error?: string };
        console.log(
          `Local Flair: ${local.ok ? `OK (${local.status})` : `UNREACHABLE (${local.error ?? "?"})`}`,
        );
        if (config.hub) {
          const hub = results.hubReachable as { ok: boolean; status?: number; error?: string };
          console.log(
            `Hub probe:   ${hub.ok ? `OK (${hub.status})` : `UNREACHABLE (${hub.error ?? "?"})`}`,
          );
        }
      }
      break;
    }

    default:
      console.error(
        `Unknown action: ${action}\n` +
          `Usage:\n` +
          `  tps flair install|uninstall|start|stop|restart|status|logs   (local lifecycle)\n` +
          `  tps flair set-hub <url> [--auth-mode admin-pass-file --auth-path <path>]\n` +
          `  tps flair clear-hub\n` +
          `  tps flair show [--json]\n` +
          `  tps flair probe [--json]`,
      );
      process.exit(1);
  }
}
