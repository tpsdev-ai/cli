import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { connectionAlive, listHostStates } from "../utils/connection-state.js";
import { fingerprint, loadHostIdentity, lookupBranch, registerBranch, revokeBranch } from "../utils/identity.js";
import { NoiseIkTransport } from "../utils/noise-ik-transport.js";
import { provisionTeam } from "../utils/provision.js";
import { parseOfficeManifest } from "../schema/manifest.js";
import { connectAndKeepAlive, startRelay, syncRemoteBranch } from "../utils/relay.js";
import { MSG_JOIN_COMPLETE, MSG_MAIL_DELIVER } from "../utils/wire-mail.js";
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
}


function branchRoot(): string {
  return sharedBranchRoot();
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
  const countDir = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).length : 0;
  return {
    newCount: countDir(join(root, "new")),
    curCount: countDir(join(root, "cur")),
    failedCount: countDir(join(root, "failed")),
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
      console.error(`Failed to inject secret ${key}`);
    }
  }
  spawnSync("docker", [
    "exec", containerName, "touch", "/run/secrets/.ready",
  ], { stdio: "pipe", encoding: "utf-8", timeout: 5_000 });
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
      // Secrets piped via stdin — never appear in process args or logs.
      if (secretsToInject.length > 0) {
        injectSecrets(sName, secretsToInject);
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
      if (!args.agent) {
        const states = listHostStates();
        if (states.length === 0) {
          console.log("No active branch connections.");
          return;
        }
        for (const s of states) {
          const alive = connectionAlive(s.branch);
          const age = Math.round((Date.now() - new Date(s.connectedAt).getTime()) / 1000);
          const lastAck = s.lastHeartbeatAck
            ? Math.round((Date.now() - new Date(s.lastHeartbeatAck).getTime()) / 1000) + "s ago"
            : "never";
          const anomaly = !alive ? " ⚠️  STALE (PID dead)" : s.reconnectCount > 3 ? ` ⚠️  ${s.reconnectCount} reconnects` : "";
          console.log(`${s.branch.padEnd(12)} ${alive ? "connected" : "STALE"}  ${age}s  ↑${s.messagesSent}msg  ↓${s.messagesReceived}msg  last ack: ${lastAck}${anomaly}`);
        }
        return;
      }
      const agent = validateAgent(args.agent);
      const ws = workspacePath(agent);
      const relayRunning = existsSync(relayPidFile(agent));
      const counts = outboxCounts(agent);
      const sb = findContainer(agent);
      
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      const isSoundstage = existsSync(soundstageMarker);

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
      setInterval(() => {}, 60_000);
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
        console.error("Usage: tps office join <name> <join-token>");
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

      await channel.send({
        type: MSG_JOIN_COMPLETE,
        seq: 0,
        ts: new Date().toISOString(),
        body: {
          hostPubkey: Buffer.from(hostKp.encryption.publicKey).toString("base64url"),
          hostFingerprint: fingerprint(hostKp.encryption.publicKey),
          hostId: process.env.TPS_HOST_ID || "host",
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
        onMessage: (msg) => {
          if (msg.type === MSG_MAIL_DELIVER) {
            console.log(`\n[${new Date().toLocaleTimeString()}] ✉️ Mail received`);
          }
        }
      });

      console.log(`Persistent connection active for '${args.agent}'. Press Ctrl+C to disconnect.`);
      process.on("SIGINT", async () => {
        await stop();
        process.exit(0);
      });
      setInterval(() => {}, 60_000);
      return;
    }

    case "kill": {
      let killed = 0;
      const { listHostStates, clearHostState } = await import("../utils/connection-state.js");
      const states = listHostStates();
      for (const s of states) {
        try {
          process.kill(s.pid, "SIGTERM");
          clearHostState(s.branch);
          killed++;
        } catch {
          clearHostState(s.branch);
        }
      }

      const pidPath = join(process.env.HOME || homedir(), ".tps", "branch", "branch.pid");
      if (existsSync(pidPath)) {
        try {
          const pid = Number(readFileSync(pidPath, "utf-8").trim());
          if (pid) {
            process.kill(pid, "SIGTERM");
            killed++;
          }
        } catch {}
        try { rmSync(pidPath, { force: true }); } catch {}
      }

      console.log(`Kill switch engaged. Terminated ${killed} TPS process(es).`);
      break;
    }
  }
}
