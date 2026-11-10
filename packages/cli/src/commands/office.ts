import { isMailboxMessageFile } from "@tpsdev-ai/agent";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidState, pidStateFromProbeError } from "@tpsdev-ai/agent";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { listHostStatePaths, withHostStateRecordLock } from "../utils/connection-state.js";
import { readPidFile, removePidFile } from "../utils/pid-file.js";
import { branchTestPause, pidPath as branchPidPath, pidRecordBytesEqual, snapshotPidRecord, withBranchPidLock, type PidRecordSnapshot } from "./branch.js";
import { fingerprint, loadHostIdentity, lookupBranch, registerBranch, revokeBranch } from "../utils/identity.js";
import { NoiseIkTransport } from "../utils/noise-ik-transport.js";
import { provisionTeam } from "../utils/provision.js";
import { parseOfficeManifest } from "../schema/manifest.js";
import { connectAndKeepAlive, startRelay, syncRemoteBranch } from "../utils/relay.js";
import { MSG_JOIN_COMPLETE } from "../utils/wire-mail.js";
import { ensureDefaultServices, listServices } from "../utils/service-registry.js";
import { WsNoiseTransport } from "../utils/ws-noise-transport.js";
import { branchRoot as sharedBranchRoot, resolveTeamId, workspacePath as sharedWorkspacePath } from "../utils/workspace.js";
import { runOfficeManager, OFFICE_READY_MARKER, loadWorkspaceManifest } from "./office-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface OfficeArgs {
  action: "start" | "stop" | "rm" | "list" | "status" | "relay" | "exec" | "join" | "revoke" | "sync" | "connect" | "kill" | "setup";
  agent?: string;
  command?: string[];
  manifest?: string;
  soundstage?: boolean;
  joinToken?: string;
  dryRun?: boolean;
  json?: boolean;
  tunnelVia?: string;
  port?: number;
  force?: boolean;
  keepUnits?: boolean;
  // ops-209a: Flair spoke auto-provisioning
  noFlair?: boolean;
  forceReinstallFlair?: boolean;
  purgeFlair?: boolean;
}


function branchRoot(): string {
  return sharedBranchRoot();
}

/** The signal sender for `office kill`; replaceable in tests so they can
 *  assert that an unverified or stale record sends nothing. */
type OfficeKillSignal = (pid: number) => void;
let sendOfficeKillSignal: OfficeKillSignal = (pid) => process.kill(pid, "SIGTERM");

export function setOfficeKillSignal(fn: OfficeKillSignal): OfficeKillSignal {
  const previous = sendOfficeKillSignal;
  sendOfficeKillSignal = fn;
  return previous;
}

/** Reads `/proc/<pid>/stat`; replaceable in tests so they can exercise a read
 *  that fails for a live pid. */
type ProcStatReader = (pid: number) => string;
let readProcStat: ProcStatReader = (pid) => readFileSync(`/proc/${pid}/stat`, "utf-8");

export function setProcStatReader(fn: ProcStatReader): ProcStatReader {
  const previous = readProcStat;
  readProcStat = fn;
  return previous;
}

/** True when `kill(pid, 0)` was refused with an error pidState calls alive. */
function killProbeRefused(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return pidStateFromProbeError(error) === "alive";
  }
}

/** True when Linux reports the pid in state `Z`: it has exited but still
 *  answers `kill(pid, 0)` until its parent reaps it. Null when this platform or
 *  this read cannot say. A missing `/proc` entry is not proof of exit
 *  (hidepid, another pid namespace), so absence is left to the
 *  `pidState === "gone"` path. */
export function linuxProcessExited(pid: number): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readProcStat(pid);
    // Field 2 (comm) may contain spaces and parentheses, so field 3 (state)
    // follows the space after the last ")".
    const rparen = stat.lastIndexOf(")");
    const state = stat[rparen + 2];
    if (rparen === -1 || stat[rparen + 1] !== " " || !state || !"RSDZTtWXxKPI".includes(state)) return null;
    return state === "Z";
  } catch {
    return null;
  }
}

/** Wait for a signalled process to exit, polling for up to about 5 s. */
async function waitForKillExit(pid: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (pidState(pid) === "gone") return true;
    if (linuxProcessExited(pid) === true) return true;
    if (killProbeRefused(pid)) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pidState(pid) === "gone" || linuxProcessExited(pid) === true;
}

function workspacePath(agentId: string): string {
  return sharedWorkspacePath(agentId);
}

function sandboxName(agentId: string): string {
  const teamId = resolveTeamId(agentId);
  return `tps-${teamId}`;
}

function relayPidFile(agentId: string): string {
  return join(workspacePath(agentId), "relay.pid");
}

function outboxCounts(agentId: string): { newCount: number; curCount: number; failedCount: number } {
  const ws = workspacePath(agentId);
  const root = join(ws, "mail", "outbox");
  const countDir = (dir: string, fresh = false) => existsSync(dir) ? readdirSync(dir).filter(f => fresh ? isMailboxMessageFile(f) : f.endsWith(".json")).length : 0;
  return {
    newCount: countDir(join(root, "new"), true),
    curCount: countDir(join(root, "cur")),
    failedCount: countDir(join(root, "failed")),
  };
}

function lastSeenFromPaths(paths: string[]): string {
  const timestamps = paths
    .filter((path) => existsSync(path))
    .map((path) => statSync(path).mtime.toISOString());
  return timestamps[0] ?? new Date(0).toISOString();
}

/** The checked shutdown `office connect` registers for SIGINT and SIGTERM:
 *  stop the relay, clear the host record, report a failed disconnect and exit
 *  non-zero. One handler serves both signals; a signal that arrives while it
 *  runs starts no second shutdown. */
export function createConnectShutdown(
  stop: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  report: (line: string) => void = (line) => console.error(line),
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await stop();
    } catch (error) {
      report(`Disconnect failed: ${(error as Error).message}`);
      exit(1);
      return;
    }
    exit(0);
  };
}

function validateAgent(agent?: string): string {
  if (!agent) {
    console.error("Agent name is required.");
    process.exit(1);
  }
  const safe = sanitizeIdentifier(agent);
  if (safe !== agent) {
    console.error(`Invalid agent identifier: ${agent}`);
    process.exit(1);
  }
  return agent;
}

interface ContainerState {
  name: string;
  status: string;
  state: string;
}

function listDockerContainers(filterName?: string): ContainerState[] {
  if (process.env.TPS_OFFICE_SKIP_VM === "1") return [];

  const args = ["ps", "-a", "--format", "{{json .}}"]; 
  if (filterName) args.push("--filter", `name=${filterName}`);

  const result = spawnSync("docker", args, { encoding: "utf-8", timeout: 10_000 });
  if (result.status !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return {
          name: (parsed.Names || "").split(",")[0],
          status: String(parsed.Status || "unknown"),
          state: String(parsed.State || "unknown"),
        };
      } catch {
        return null;
      }
    })
    .filter((row): row is ContainerState => Boolean(row));
}

function findContainer(agentId: string): ContainerState | null {
  const sName = sandboxName(agentId);
  const containers = listDockerContainers(sName);
  return containers.find((s) => s.name === sName) || null;
}

function parseManifestMountArgs(manifestPath?: string): string[] {
  if (!manifestPath) return [];
  const manifest = parseOfficeManifest(manifestPath);
  const mounts = manifest.mounts || [];
  const result: string[] = [];
  const pathMod = require("node:path");
  const fs = require("node:fs");

  const home = pathMod.resolve(process.env.HOME || "");

  for (const m of mounts) {
    if (!m.target.startsWith("/workspace")) {
      throw new Error(`Invalid manifest mount target: ${m.target}`);
    }
    if (m.target.includes("..")) {
      throw new Error(`Manifest mount target traversal not allowed: ${m.target}`);
    }

    const rawHost = m.host.startsWith("~/") ? pathMod.join(home, m.host.slice(2)) : m.host;
    const host = pathMod.resolve(rawHost);
    const hostReal = fs.realpathSync(host);
    if (!hostReal.startsWith(home + pathMod.sep)) {
      throw new Error(`Manifest mount host outside HOME: ${m.host}`);
    }

    const roFlag = m.readonly ? ":ro" : "";
    result.push("-v", `${hostReal}:${m.target}${roFlag}`);
  }

  return result;
}

function dockerImageFromManifest(manifestPath?: string): string {
  if (!manifestPath) return "ghcr.io/tpsdev-ai/tps-office:latest";
  const manifest = parseOfficeManifest(manifestPath);
  return (manifest as any).image || "ghcr.io/tpsdev-ai/tps-office:latest";
}

export function parseJoinToken(tokenUrl: string): any {
  const url = new URL(tokenUrl);
  if (url.protocol !== "tps:" || url.host !== "join") {
    throw new Error("Invalid join token protocol. Must be tps://join?...");
  }

  const host = url.searchParams.get("host");
  const port = Number(url.searchParams.get("port"));
  const pubkey = url.searchParams.get("pubkey");
  const sigpubkey = url.searchParams.get("sigpubkey");
  const fp = url.searchParams.get("fp");

  if (!host || isNaN(port) || !pubkey || !sigpubkey || !fp) {
    throw new Error("Invalid join token: missing required parameters");
  }

  return {
    host,
    port,
    transport: (url.searchParams.get("transport") as "ws" | "tcp") || "ws",
    encryptionPubkey: new Uint8Array(Buffer.from(pubkey, "base64url")),
    signingPubkey: new Uint8Array(Buffer.from(sigpubkey, "base64url")),
    fingerprint: fp,
  };
}

function setupWorkspace(agent: string): string {
  const ws = workspacePath(agent);
  mkdirSync(join(ws, "mail", "inbox", "new"), { recursive: true });
  mkdirSync(join(ws, "mail", "inbox", "cur"), { recursive: true });
  mkdirSync(join(ws, "mail", "outbox", "new"), { recursive: true });
  mkdirSync(join(ws, "mail", "outbox", "cur"), { recursive: true });
  mkdirSync(join(ws, "mail", "outbox", "failed"), { recursive: true });
  mkdirSync(join(ws, "mail", "outbox", "paused"), { recursive: true });

  const tpsDir = join(ws, ".tps");
  const agentConfig = join(tpsDir, "agent.yaml");
  if (!existsSync(agentConfig)) {
    mkdirSync(tpsDir, { recursive: true });
    const yaml = [
      `agentId: ${agent.toLowerCase()}`,
      `name: ${agent}`,
      `workspace: /workspace/${agent}`,
      `mailDir: /workspace/${agent}/mail`,
      "llm:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "  apiKey: ${ANTHROPIC_API_KEY}",
      "",
    ].join("\n");
    writeFileSync(agentConfig, yaml, "utf-8");
  }

  return ws;
}

/**
 * S33B-E: Inject secrets into container tmpfs via stdin pipe.
 * Secrets never appear in process args, logs, or docker inspect.
 */
function injectSecrets(containerName: string, secrets: Array<{ key: string; value: string }>): void {
  for (const { key, value } of secrets) {
    const result = spawnSync("docker", [
      "exec", "-i", containerName, "sh", "-c",
      `cat > "/run/secrets/${key}" && chmod 600 "/run/secrets/${key}"`,
    ], { input: value, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", timeout: 10_000 });
    if (result.status !== 0) {
      throw new Error(`failed to inject secret '${key}' into container`);
    }
  }
  const readyResult = spawnSync("docker", [
    "exec", containerName, "touch", "/run/secrets/.ready",
  ], { stdio: "pipe", encoding: "utf-8", timeout: 5_000 });
  if (readyResult.status !== 0) {
    throw new Error("failed to mark /run/secrets/.ready");
  }
}

/**
 * ops-209a: Conditionally provision Flair spoke on the remote branch.
 * Called from join when --tunnel-via is given and --no-flair is not set.
 */
export async function provisionFlairIfRequested(args: OfficeArgs, agent: string): Promise<void> {
  if (args.noFlair) {
    console.log("ℹ️  --no-flair: skipping Flair spoke provisioning.");
    return;
  }

  try {
    const {
      buildFlairPlan,
      flairSpokeExists,
      installFlairSpoke,
      configureFederation,
    } = await import("./office-flair-spoke.js");

    const plan = buildFlairPlan();

    if (plan.mode === "error") {
      console.error(`❌ Flair spoke provisioning blocked: ${plan.error}`);
      process.exitCode = 1;
      return;
    }

    // Idempotency check
    if (flairSpokeExists(args.tunnelVia!, agent)) {
      if (!args.forceReinstallFlair) {
        console.error(
          `❌ Flair is already installed on '${args.tunnelVia}'.\n` +
          `   Use --force-reinstall-flair to reinstall (preserves data unless --purge-flair).`
        );
        process.exitCode = 1;
        return;
      }
      console.log("♻️  Force-reinstalling Flair spoke...");
    }

    console.log("");
    console.log(`🧠 Flair spoke provisioning (mode: ${plan.mode}):`);
    console.log(`   Branch: ${agent}`);
    console.log(`   Remote: ${args.tunnelVia}`);
    if (plan.mode === "hub-less") {
      console.log("   Hub:    (none — hub-less mode, branch memories are an island)");
    } else {
      console.log(`   Hub:    ${plan.hub}`);
    }

    const state = installFlairSpoke(args.tunnelVia!, agent, plan);
    console.log(`   ✅ Flair installed (port ${state.port}, unit ${state.unitName})`);

    if (plan.mode === "spoke") {
      try {
        const fed = configureFederation(args.tunnelVia!, agent, plan);
        if (fed.lastSync) {
          console.log(`   ✅ Fed-sync configured + validated (timer ${fed.timerName})`);
        } else if (state.os === "linux") {
          process.exitCode = 1;
          console.log(`   ⚠️  Fed-sync partially configured: initial sync failed.`);
          console.log(`       Branch is hub-less until the sync is working.`);
        }
      } catch (e: any) {
        console.error(`   ⚠️  Fed-sync configuration failed: ${e.message}`);
        console.error(`       Flair is installed but federation is not active.`);
        process.exitCode = 1;
      }
    }
  } catch (e: any) {
    console.error(`❌ Flair spoke provisioning failed: ${e.message}`);
    console.error("   The join was successful — fix the issue and re-run with --force-reinstall-flair.");
    process.exitCode = 1;
  }
}

export async function runOffice(args: OfficeArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      const manifest = args.manifest;
      if (manifest) {
        try {
          provisionTeam(manifest, branchRoot());
        } catch (e: any) {
          console.error(`Failed to provision team: ${e.message}`);
          process.exit(1);
        }
      }
      const manifestData = manifest ? parseOfficeManifest(manifest) : null;
      const agent = validateAgent(args.agent);
      const ws = setupWorkspace(agent);
      const teamId = resolveTeamId(agent);
      const isTeam = teamId !== agent;
      const sName = sandboxName(agent);
      const image = dockerImageFromManifest(manifest);

      if (args.soundstage) {
        console.log("🎬 Soundstage mode enabled (Mock LLM, local isolation)");
        const teamRoot = join(branchRoot(), teamId);
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(join(teamRoot, "soundstage.json"), JSON.stringify({ enabled: true, startedAt: new Date().toISOString() }));

      }

      if (manifestData && manifestData.name !== teamId && manifestData.name !== agent) {
        console.warn(`Manifest name mismatch: ${manifestData.name}`);
      }

      if (isTeam) {
        console.log(`(Shared team sandbox: ${teamId})`);
      }

      if (process.env.TPS_OFFICE_SKIP_VM === "1") {
        console.log(`✓ Office ready for ${agent} (SKIPPED).`);
        return;
      }

      const mountArgs = parseManifestMountArgs(manifest);
      const workspaceMount = isTeam ? join(branchRoot(), teamId) : ws;
      mountArgs.push("-v", `${workspaceMount}:/workspace`);
      // Mail dirs are inside each agent workspace — no separate /mail mount needed
      mountArgs.push("--mount", "type=tmpfs,destination=/run/secrets");

      const existing = findContainer(agent);
      if (existing) {
        if (existing.state === "running") {
          console.log(`Office already running for ${agent} (container: ${sName})`);
          return;
        }
        const runResult = spawnSync("docker", ["start", sName], { stdio: "inherit", encoding: "utf-8" });
        if (runResult.status !== 0) {
          console.error(`Failed to resume office for ${agent}`);
          process.exit(runResult.status ?? 1);
        }
        console.log(`✓ Office resumed for ${agent}`);
        return;
      }

      const teamJsonPath = join(workspaceMount, ".tps", "team.json");
      mkdirSync(dirname(teamJsonPath), { recursive: true });
      writeFileSync(
        teamJsonPath,
        JSON.stringify(
          {
            agents: [
              {
                id: agent,
                workspace: `/workspace/${agent}`,
                configPath: `/workspace/${agent}/.tps/agent.yaml`,
              },
            ],
          },
          null,
          2
        )
      );

      // S33B-E: Pass secrets via tmpfs files, not env vars.
      // Env vars leak via `docker inspect`. Instead, we start the container,
      // write secrets to /run/secrets (tmpfs), then the supervisor reads + unlinks
      // before starting agents. Secrets exist only in memory.
      const API_KEY_VARS = [
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
        "GEMINI_API_KEY", "OLLAMA_HOST",
      ];
      const envPassthrough: string[] = [];
      const secretsToInject: Array<{ key: string; value: string }> = [];
      for (const key of API_KEY_VARS) {
        const val = process.env[key];
        if (val) {
          secretsToInject.push({ key, value: val });
        }
      }

      const createResult = spawnSync("docker", [
        "run", "-d", "--name", sName,
        ...envPassthrough,
        ...mountArgs,
        image,
      ], { stdio: "inherit", encoding: "utf-8", timeout: 120_000 });

      if (createResult.status !== 0) {
        console.error(`Failed to start office container for ${agent}`);
        process.exit(createResult.status ?? 1);
      }

      // S33B-E: Inject secrets into tmpfs after container start.
      // Supervisor waits for /run/secrets/.ready before booting agents.
      // Always mark .ready (even with zero secrets) so startup is deterministic.
      // Secrets piped via stdin — never appear in process args or logs.
      try {
        injectSecrets(sName, secretsToInject);
      } catch (e: any) {
        console.error(`Secret injection failed: ${e?.message || e}`);
        try { spawnSync("docker", ["rm", "-f", sName], { stdio: "pipe", encoding: "utf-8" }); } catch {}
        process.exit(1);
      }

      if (manifest && loadWorkspaceManifest(ws)) {
        console.log("Workspace manifest found — running Office Manager...");
        const ok = await runOfficeManager(ws, { dryRun: false });
        if (!ok) process.exit(1);
      }

      console.log(`✓ Office started for ${agent} (container: ${sName})`);
      console.log(`  Exec: tps office exec ${agent} -- <command>`);
      console.log(`  Stop: tps office stop ${agent}`);
      return;
    }

    case "setup": {
      const agent = validateAgent(args.agent);
      const ws = workspacePath(agent);
      const ok = await runOfficeManager(ws, { dryRun: args.dryRun ?? false });
      if (!ok) process.exit(1);
      return;
    }

    case "stop": {
      const agent = validateAgent(args.agent);
      const sName = sandboxName(agent);
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      if (existsSync(soundstageMarker)) {
        try { unlinkSync(soundstageMarker); } catch {}
      }

      const sb = findContainer(agent);
      if (!sb) {
        console.error(`No office found for ${agent}`);
        process.exit(1);
      }

      if (sb.state === "exited") {
        console.log(`Office for ${agent} is already stopped.`);
        return;
      }

      console.log(`Stopping office for ${agent}...`);
      const stopResult = spawnSync("docker", ["stop", sName], { stdio: "inherit", encoding: "utf-8" });
      if (stopResult.status !== 0) {
        console.error(`Failed to stop sandbox for ${agent}`);
        process.exit(stopResult.status ?? 1);
      }

      console.log(`✓ Office stopped for ${agent}.`);
      return;
    }

    case "rm": {
      const agent = validateAgent(args.agent);
      const ws = workspacePath(agent);
      const sName = sandboxName(agent);

      const stopResult = spawnSync("docker", ["rm", "-f", sName], { stdio: "inherit", encoding: "utf-8" });
      if (stopResult.status !== 0 && stopResult.status !== 1) {
        console.error(`Failed to remove office ${agent}`);
        process.exit(stopResult.status ?? 1);
      }

      const filesToClean = [join(ws, ".tps", "pids.json"), join(ws, ".tps", "team.json")];
      for (const file of filesToClean) {
        try { rmSync(file, { force: true }); } catch {}
      }

      console.log(`✓ Office removed for ${agent} (container ${sName}).`);
      return;
    }

    case "list": {
      const sandboxes = process.env.TPS_OFFICE_SKIP_VM === "1" ? [] : listDockerContainers().filter((s) => s.name.startsWith("tps-"));
      const root = branchRoot();
      const localAgents = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d))) : [];

      if (sandboxes.length === 0 && localAgents.length === 0) {
        console.log("No branch offices found.");
        return;
      }

      // Show Docker sandboxes
      for (const sb of sandboxes) {
        const agentName = sb.name.replace(/^tps-/, "");
        console.log(`- ${agentName}  ${sb.state}  ${sb.status}  sandbox=${sb.name}`);
      }

      // Show local-only workspaces (no sandbox yet)
      const sandboxAgents = new Set(sandboxes.map((s) => s.name.replace(/^tps-/, "")));
      for (const a of localAgents) {
        if (!sandboxAgents.has(a)) {
          console.log(`- ${a}  no sandbox  (workspace only)`);
        }
      }
      return;
    }

    case "status": {
      const timestamp = new Date().toISOString();
      const agent = validateAgent(args.agent);
      const ws = workspacePath(agent);
      const relayRunning = existsSync(relayPidFile(agent));
      const counts = outboxCounts(agent);
      const sb = findContainer(agent);
      
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      const isSoundstage = existsSync(soundstageMarker);
      if (args.json) {
        const status = sb ? sb.state : relayRunning ? "relay-running" : "not running";
        const lastSeen = lastSeenFromPaths([
          relayPidFile(agent),
          soundstageMarker,
          join(ws, ".tps", "team.json"),
          ws,
        ]);
        console.log(JSON.stringify({ agents: [{ id: agent, status, lastSeen }], timestamp }, null, 2));
        return;
      }

      console.log(`Agent: ${agent}`);
      console.log(`Workspace: ${ws}`);
      
      if (isSoundstage) {
        console.log(`Mode: 🎬 soundstage (mock LLM, real sandbox)`);
      }

      if (sb) {
        console.log(`Office: ${sb.state} (sandbox: ${sb.name})`);
      } else {
        console.log(`Office: not running`);
      }

      console.log(`Relay: ${relayRunning ? "running" : "stopped"}`);
      console.log(`Outbox pending: ${counts.newCount} (cur=${counts.curCount}, failed=${counts.failedCount})`);

      const pausedDir = join(ws, "mail", "outbox", "paused");
      if (existsSync(pausedDir)) {
        const pausedCount = readdirSync(pausedDir).filter((f) => f.endsWith(".json")).length;
        if (pausedCount > 0) {
          console.log(`⚠️  Paused messages (loop detected): ${pausedCount}`);
          console.log(`   Review: ${pausedDir}`);
        }
      }

      // ops-7x9y: report supervision state via launchd
      try {
        const { readSupervision, getUnitState } = await import("./office-supervision.js");
        const sup = readSupervision(agent);
        if (sup) {
          const tunnelState = getUnitState(sup.tunnel.plistLabel);
          const officeState = getUnitState(sup.office.plistLabel);
          
          const loadedIcon = (s: { loaded: boolean }) => s.loaded ? "🟢" : "🔴";
          
          if (args.json) {
            // Already printed json above — re-print with supervision added
            console.error("Note: --json output for supervised offices is not yet merged. Use plain text status.");
          } else {
            console.log(`\n🔒 Supervision (launchd):`);
            console.log(`   ${loadedIcon(tunnelState)} Tunnel: ${sup.tunnel.plistLabel} → port ${sup.tunnel.localPort} via ${sup.tunnel.tunnelVia}${tunnelState.pid ? ` (PID ${tunnelState.pid})` : ""}`);
            console.log(`   ${loadedIcon(officeState)} Office: ${sup.office.plistLabel}${officeState.pid ? ` (PID ${officeState.pid})` : ""}`);
            console.log(`   Installed: ${sup.installedAt}`);

            // ops-209a: report Flair spoke health if installed
            try {
              const { checkFlairHealth } = await import("./office-flair-spoke.js");
              const fl = checkFlairHealth(sup.tunnel.tunnelVia, agent);
              if (fl.installed) {
                console.log(`\n🧠 Flair spoke:`);
                console.log(`   Flair:    ${fl.unitActive ? "🟢" : "🔴"} ${fl.flairDir} (port ${fl.port})`);
                console.log(`   API:      ${fl.apiReachable ? "✅ reachable" : "❌ unreachable"}`);
                if (fl.fedSyncConfigured) {
                  console.log(`   Fed-Sync: ${fl.fedSyncActive ? "🟢" : "🔴"} → ${fl.fedSyncConfigured ? "hub" : "none"}${fl.lastFedSync ? ` (last: ${fl.lastFedSync})` : " (never synced)"}`);
                }
              }
            } catch {
              // best-effort — status should never crash on missing flair spoke module
            }
          }
        }
      } catch {
        // best-effort — status should never crash on missing supervision module
      }

      return;
    }

    case "relay": {
      const agent = validateAgent(args.agent);
      const stop = startRelay(agent);
      process.on("SIGTERM", () => {
        stop();
        process.exit(0);
      });
      process.on("SIGINT", () => {
        stop();
        process.exit(0);
      });
      // bun drops the no-op interval; hold the loop until SIGTERM/SIGINT.
      await new Promise<void>(() => {});
      return;
    }

    case "exec": {
      const agent = validateAgent(args.agent);
      const sName = sandboxName(agent);
      const ws = workspacePath(agent);

      const sb = findContainer(agent);
      if (!sb || sb.state !== "running") {
        console.error(`Office for ${agent} is not running. Start it with: tps office start ${agent}`);
        process.exit(1);
      }

      const cmd = args.command;
      if (!cmd || cmd.length === 0) {
        console.error("Usage: tps office exec <agent> -- <command...>");
        process.exit(1);
      }

      const result = spawnSync("docker", ["exec", "-i", sName, ...cmd], { encoding: "utf-8", cwd: ws, stdio: "inherit" });
      process.exit(result.status ?? 0);
      return;
    }

    case "join": {
      if (!args.agent || !args.joinToken) {
        console.error("Usage: tps office join <name> <join-token> [--tunnel-via <ssh-host>] [--port <n>] [--force]");
        process.exit(1);
      }
      const agent = validateAgent(args.agent);
      
      const token = parseJoinToken(args.joinToken);

      registerBranch(
        agent,
        token.signingPubkey,
        {
          fingerprint: `sha256:${fingerprint(token.signingPubkey)}`,
          trust: "standard",
        },
        token.encryptionPubkey
      );

      console.log(`Connecting to ${token.host}:${token.port}...`);

      const hostKp = await loadHostIdentity();
      const wire = token.transport === "ws" ? new WsNoiseTransport(hostKp) : new NoiseIkTransport(hostKp);
      const channel = await wire.connect({
        host: token.host,
        port: token.port,
        branchId: agent,
        hostPublicKey: token.encryptionPubkey,
      });

      console.log(`Noise_IK handshake OK — branch fingerprint verified: ${token.fingerprint}`);

      // Ensure default services (e.g. flair) are in the registry before advertising
      ensureDefaultServices();
      const advertisedServices = listServices()
        .filter((s) => s.localPort)
        .map((s) => ({ name: s.name, localPort: s.localPort!, description: s.description }));

      await channel.send({
        type: MSG_JOIN_COMPLETE,
        seq: 0,
        ts: new Date().toISOString(),
        body: {
          hostPubkey: Buffer.from(hostKp.encryption.publicKey).toString("base64url"),
          hostFingerprint: fingerprint(hostKp.encryption.publicKey),
          hostId: process.env.TPS_HOST_ID || "host",
          services: advertisedServices,
        },
      });

      const ws = workspacePath(agent);
      mkdirSync(ws, { recursive: true });
      const remoteRecord = {
        host: token.host,
        port: token.port,
        branchId: agent,
        fingerprint: token.fingerprint,
        pubkey: Buffer.from(token.encryptionPubkey).toString("base64url"),
        joinedAt: new Date().toISOString(),
        transport: token.transport,
      };
      writeFileSync(join(ws, "remote.json"), JSON.stringify(remoteRecord, null, 2), "utf-8");

      await channel.close();
      console.log(`Branch '${agent}' registered.`);
      console.log("Host pubkey sent to branch.");

      // ops-7x9y: provision launchd supervision when --tunnel-via is given
      if (args.tunnelVia) {
        const { installSupervision, supervisionExists: supExists, teardownSupervision } = await import("./office-supervision.js");

        if (supExists(agent)) {
          if (!args.force) {
            console.error(
              `❌ Supervision already exists for '${agent}'.\n` +
              `   Use --force to regenerate and reload, or tps office revoke ${agent} to tear down.`
            );
            process.exit(1);
          }
          // With --force: tear down existing first, then reinstall
          console.log("♻️  Force-regenerating supervision units...");
          teardownSupervision(agent);
        }

        try {
          const result = installSupervision(agent, args.tunnelVia, args.port);
          console.log("");
          console.log("🔒 Supervision installed (launchd):");
          console.log(`   Tunnel:    ${result.tunnelLabel} → port ${result.localPort} via ${args.tunnelVia}`);
          console.log(`   Office:    ${result.officeLabel}`);
          console.log(`   Manifest:  ~/.tps/branch-office/${agent}/supervision.json`);
          console.log(`   Logs:      ~/.tps/logs/`);
          console.log("");
          console.log("   Units auto-start at login and restart on crash.");
          console.log(`   Revoke with: tps office revoke ${agent}`);
        } catch (e: any) {
          console.error(`❌ Supervision provisioning failed: ${e.message}`);
          // Don't undo the join — the branch is still registered, but the
          // command reports the failed step through its exit status.
          process.exitCode = 1;
        }

        // ops-209a: provision Flair spoke on the remote branch (default=on, opt-out with --no-flair)
        await provisionFlairIfRequested(args, agent);
      }

      return;
    }

    case "revoke": {
      const agent = validateAgent(args.agent);

      revokeBranch(agent, "manual revocation");
      const ws = workspacePath(agent);
      const rPath = join(ws, "remote.json");
      if (existsSync(rPath)) {
        try { unlinkSync(rPath); } catch {}
      }
      console.log(`Branch '${agent}' revoked.`);

      // ops-7x9y: tear down supervision AFTER branch revocation succeeds.
      // Doing it after ensures supervision is not orphaned if revokeBranch throws.
      if (!args.keepUnits) {
        try {
          const { teardownSupervision, supervisionExists: supExists } = await import("./office-supervision.js");
          if (supExists(agent)) {
            const result = teardownSupervision(agent);
            if (result) {
              console.log(`🧹 Supervision units unloaded: ${result.tunnelLabel}, ${result.officeLabel}`);
            }
          }
        } catch (e: any) {
          console.error(`⚠️  Supervision teardown warning: ${e.message}`);
          // Don't fail — revocation already succeeded
        }
      }

      // ops-209a: tear down Flair spoke (fed-sync + Flair unit + manifest fields)
      try {
        const { readSupervision } = await import("./office-supervision.js");
        const sup = readSupervision(agent);
        if (sup) {
          const { teardownFlairSpoke } = await import("./office-flair-spoke.js");
          await teardownFlairSpoke(sup.tunnel.tunnelVia, agent, {
            purgeFlair: args.purgeFlair,
          });
        }
      } catch (e: any) {
        console.error(`⚠️  Flair spoke teardown warning: ${e.message}`);
        // Don't fail — revocation already succeeded
      }

      return;
    }

    case "sync": {
      if (!args.agent) {
        console.error("Usage: tps office sync <name>");
        process.exit(1);
      }
      const { syncRemoteBranch: syncRemote } = await import("../utils/relay.js");
      const { received } = await syncRemote(args.agent);
      console.log(`Sync complete. Received ${received} message(s).`);
      return;
    }

    case "connect": {
      if (!args.agent) {
        console.error("Usage: tps office connect <name>");
        process.exit(1);
      }
      const hostKp = await loadHostIdentity();
      const stop = await connectAndKeepAlive(args.agent, {
        onAccepted: () => {
          console.log(`\n[${new Date().toLocaleTimeString()}] ✉️ Mail received`);
        }
      });

      console.log(`Persistent connection active for '${args.agent}'. Press Ctrl+C to disconnect.`);
      // `office kill` and service managers stop the connector with SIGTERM, so
      // both signals run the same checked shutdown.
      const shutdown = createConnectShutdown(stop);
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      // bun drops the no-op interval; hold the loop until SIGTERM/SIGINT.
      await new Promise<void>(() => {});
      return;
    }

    case "kill": {
      let killed = 0;
      const failures: string[] = [];
      // Limit host-record handling to a bounded number of passes.
      const MAX_HOST_RECORD_PASSES = 5;
      const processedHostRecords = new Set<string>();
      const recordKey = (path: string, state: ReturnType<typeof readPidFile>): string | null => {
        switch (state.kind) {
          case "missing":
            return null;
          case "unreadable":
            return `${path}\0unreadable`;
          case "invalid":
            return `${path}\0invalid:${state.reason}`;
          case "stale":
            return `${path}\0stale:${state.pid}`;
          case "running":
            return `${path}\0running:${state.pid}:${state.startToken}`;
          case "unverified":
            return `${path}\0unverified:${state.pid}:${state.startToken ?? ""}`;
        }
      };

      const removeRecord = (path: string): "removed" | "already gone" | "kept" => {
        try {
          return removePidFile(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "unknown";
          failures.push(`Pid record ${path} could not be removed (${code}); the record was kept.`);
          return "kept";
        }
      };
      const refusal = (label: string, pid: number, path: string): string =>
        `${label} ${path} names pid ${pid}, but that process's identity cannot be verified. Check that pid and stop it yourself, or remove ${path} if that process is not running.`;
      type UnchangedRemoval = "removed" | "already gone" | "kept" | "changed" | "unreadable";

      const removeIfUnchanged = (
        label: string,
        path: string,
        snapshot: PidRecordSnapshot,
        removed: string,
        gone: string,
      ): UnchangedRemoval => withHostStateRecordLock(path, "remove the host state record", () => {
        // Compare the record's bytes before unlinking under the writer's lock,
        // so the host connection writer cannot replace it between this read and
        // the removal.
        const current = snapshotPidRecord(path);
        if (current.state.kind === "missing") {
          console.log(gone);
          return "already gone";
        }
        if (current.state.kind === "unreadable") {
          failures.push(
            `${label} ${path} could not be read at the final check${current.state.reason === undefined ? "" : ` (${current.state.reason})`}; the record was kept. Inspect it and remove it yourself if its process is not running.`,
          );
          return "unreadable";
        }
        if (!pidRecordBytesEqual(current.raw, snapshot.raw)) return "changed";
        // Host-only pause seam; gated so other pause users do not stop here.
        if (process.env.TPS_OFFICE_KILL_HOST_PAUSE === "1") {
          branchTestPause("office-kill-host-before-removal", path);
        }
        const removal = removeRecord(path);
        if (removal === "removed") console.log(removed);
        else if (removal === "already gone") console.log(gone);
        return removal;
      });

      const stopRecord = async (label: string, path: string): Promise<boolean> => {
        // The path comes from the directory listing.
        const decision = snapshotPidRecord(path);
        const state = decision.state;
        if (state.kind === "missing") return false;
        const key = recordKey(path, state);
        if (key !== null) {
          // Retry changed bytes at the removal check or a changed identity in a later pass, if one remains.
          if (processedHostRecords.has(key)) return false;
          processedHostRecords.add(key);
        }
        if (state.kind === "unreadable") {
          failures.push(
            `${label} ${state.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${state.path} if that process is not running.`,
          );
          return true;
        }
        if (state.kind === "invalid") {
          failures.push(`${label} ${state.path} could not be parsed (${state.reason}); the record was kept.`);
          return true;
        }
        if (state.kind === "unverified") {
          failures.push(refusal(label, state.pid, state.path));
          return true;
        }
        if (state.kind === "stale") {
          // Attempt stale-record removal without signalling; a removal failure
          // keeps the record and is reported.
          const removal = removeIfUnchanged(
            label,
            state.path,
            decision,
            `Stale ${label.toLowerCase()} removed: ${state.path}; pid ${state.pid} was not signalled.`,
            `Pid record already gone: ${state.path}; pid ${state.pid} was not signalled.`,
          );
          if (removal === "changed" && key !== null) processedHostRecords.delete(key);
          return true;
        }
        try {
          sendOfficeKillSignal(state.pid);
        } catch (error) {
          // Classify the SIGTERM error itself (ESRCH means the process is gone);
          // this is not a fresh probe. EPERM ("alive") and any other result
          // keep the record and report it.
          if (pidStateFromProbeError(error) !== "gone") {
            failures.push(`${label} could not be stopped (pid ${state.pid}); record kept at ${state.path}.`);
            return true;
          }
          const removal = removeIfUnchanged(
            label,
            state.path,
            decision,
            `Stale ${label.toLowerCase()} removed: ${state.path}.`,
            `Pid record already gone: ${state.path}.`,
          );
          if (removal === "changed" && key !== null) processedHostRecords.delete(key);
          return true;
        }
        if (!(await waitForKillExit(state.pid))) {
          failures.push(`${label} could not be stopped (pid ${state.pid}); record kept at ${state.path}.`);
          return true;
        }
        killed++;
        const removal = removeIfUnchanged(
          label,
          state.path,
          decision,
          `${label} (pid ${state.pid}) stopped; record removed: ${state.path}.`,
          `${label} (pid ${state.pid}) stopped; record already gone: ${state.path}.`,
        );
        if (removal === "changed" && key !== null) processedHostRecords.delete(key);
        return true;
      };

      const stopBranchRecord = async (path: string): Promise<void> => {
        type BranchDecision =
          | { kind: "done" }
          | { kind: "remove"; pid: number; snapshot: PidRecordSnapshot }
          | { kind: "signal"; pid: number; snapshot: PidRecordSnapshot };

        const decision: BranchDecision = withBranchPidLock(path, "stop the branch daemon", () => {
          branchTestPause("office-kill-branch-before-decision", path);
          const current = snapshotPidRecord(path);
          const state = current.state;
          if (state.kind === "missing") return { kind: "done" };
          if (state.kind === "unreadable") {
            failures.push(
              `Branch pid file ${state.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${state.path} if that process is not running.`,
            );
            return { kind: "done" };
          }
          if (state.kind === "invalid") {
            failures.push(`Branch pid file ${state.path} could not be parsed (${state.reason}); the record was kept.`);
            return { kind: "done" };
          }
          if (state.kind === "unverified") {
            failures.push(refusal("Branch pid file", state.pid, state.path));
            return { kind: "done" };
          }
          if (state.kind === "stale") return { kind: "remove", pid: state.pid, snapshot: current };
          return { kind: "signal", pid: state.pid, snapshot: current };
        });

        if (decision.kind === "done") return;

        const removeIfUnchanged = (snapshot: PidRecordSnapshot, pid: number, removed: string, gone: string): void => {
          branchTestPause("office-kill-branch-before-unlink", path);
          let unreadableReason: string | undefined;
          const removal = withBranchPidLock(path, "remove the branch pid record", () => {
            branchTestPause("office-kill-branch-before-removal", path);
            const current = snapshotPidRecord(path);
            if (current.state.kind === "missing") return "already gone" as const;
            if (current.state.kind === "unreadable") {
              unreadableReason = current.state.reason;
              return "unreadable" as const;
            }
            if (!pidRecordBytesEqual(current.raw, snapshot.raw)) return "changed" as const;
            return removeRecord(path);
          });
          if (removal === "unreadable") {
            failures.push(
              `Branch pid file ${path} could not be read at the final check${unreadableReason === undefined ? "" : ` (${unreadableReason})`}; the pid file was kept. Inspect it and remove it yourself if the branch daemon is not running.`,
            );
          } else if (removal === "changed") {
            failures.push(`Branch pid file ${path} was replaced; the branch pid file was not removed.`);
          } else if (removal === "removed") {
            console.log(removed);
          } else if (removal === "already gone") {
            console.log(gone);
          }
        };

        if (decision.kind === "remove") {
          removeIfUnchanged(
            decision.snapshot,
            decision.pid,
            `Stale branch pid file removed: ${path}; branch-record handling signalled no process.`,
            `Pid record already gone: ${path}; branch-record handling signalled no process.`,
          );
          return;
        }

        try {
          sendOfficeKillSignal(decision.pid);
        } catch (error) {
          // Classify the SIGTERM error itself (ESRCH means the process is gone);
          // this is not a fresh probe. EPERM ("alive") and any other result
          // keep the record and report it.
          if (pidStateFromProbeError(error) !== "gone") {
            failures.push(`Branch pid file could not be stopped (pid ${decision.pid}); record kept at ${path}.`);
            return;
          }
          removeIfUnchanged(
            decision.snapshot,
            decision.pid,
            `Stale branch pid file removed: ${path}; branch-record handling signalled no process.`,
            `Pid record already gone: ${path}; branch-record handling signalled no process.`,
          );
          return;
        }
        if (!(await waitForKillExit(decision.pid))) {
          failures.push(`Branch pid file could not be stopped (pid ${decision.pid}); record kept at ${path}.`);
          return;
        }
        killed++;
        removeIfUnchanged(
          decision.snapshot,
          decision.pid,
          `Branch pid file (pid ${decision.pid}) stopped; record removed: ${path}.`,
          `Branch pid file (pid ${decision.pid}) stopped; record already gone: ${path}.`,
        );
      };

      // Re-list after each signalling pass and again after the branch step.
      // Records first seen at a pass limit are named, not stopped in that pass;
      // new record paths created after the last listing are not seen.
      type HostPassResult =
        | { kind: "settled" }
        | { kind: "bound"; remaining: string[] }
        | { kind: "listing"; failure: { path: string; code: string } };

      const runHostRecordPasses = async (): Promise<HostPassResult> => {
        let hostPasses = 0;
        while (hostPasses < MAX_HOST_RECORD_PASSES) {
          const listing = listHostStatePaths();
          if (listing.failure) return { kind: "listing", failure: listing.failure };
          hostPasses++;
          let sawUnprocessed = false;
          for (const path of listing.paths) {
            try {
              if (await stopRecord("Host state record", path)) sawUnprocessed = true;
            } catch (error) {
              failures.push(`Host state record ${path}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!sawUnprocessed) return { kind: "settled" };
        }
        const listing = listHostStatePaths();
        if (listing.failure) return { kind: "listing", failure: listing.failure };
        const remaining = listing.paths.filter((path) => {
          const state = readPidFile(path);
          if (state.kind === "missing") return false;
          const key = recordKey(path, state);
          return key !== null && !processedHostRecords.has(key);
        });
        return remaining.length === 0 ? { kind: "settled" } : { kind: "bound", remaining };
      };

      const firstHostPass = await runHostRecordPasses();
      try {
        await stopBranchRecord(branchPidPath());
      } catch (error) {
        // Keep the host-record failures collected above; the aggregate report
        // below prints this one with them and still exits non-zero.
        failures.push(error instanceof Error ? error.message : String(error));
      }
      const finalHostPass = await runHostRecordPasses();
      for (const [pass, result] of [
        ["First host pass", firstHostPass],
        ["Post-branch host pass", finalHostPass],
      ] as const) {
        if (result.kind === "listing") {
          failures.push(
            `${pass}: connections directory ${result.failure.path} could not be listed (${result.failure.code}) at that point; records observed before the failure were handled. Check the directory and its records, then re-run the command.`,
          );
        } else if (result.kind === "bound") {
          failures.push(
            `${pass}: host state records were still appearing after ${MAX_HOST_RECORD_PASSES} passes: ${result.remaining.join(", ")}. Re-run the command, or stop whatever keeps creating them.`,
          );
        }
      }

      if (failures.length > 0) {
        // Print collected failures before exiting non-zero.
        for (const line of failures) console.error(line);
        throw new Error(failures.join(" "));
      }

      console.log(`Kill switch engaged. Terminated ${killed} TPS process(es).`);
      break;
    }
  }
}
