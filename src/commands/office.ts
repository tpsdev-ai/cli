import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { connectAndKeepAlive, startRelay, syncRemoteBranch } from "../utils/relay.js";
import { connectionAlive, listHostStates } from "../utils/connection-state.js";
import { sandboxSocketPath, isSandboxReady, waitForSandbox, sandboxExec, loadImageIntoSandbox } from "../utils/sandbox.js";
import { provisionTeam } from "../utils/provision.js";
import { fileURLToPath } from "node:url";
import { fingerprint, loadHostIdentity, lookupBranch, registerBranch, revokeBranch } from "../utils/identity.js";
import { NoiseIkTransport } from "../utils/noise-ik-transport.js";
import { WsNoiseTransport } from "../utils/ws-noise-transport.js";
import { MSG_JOIN_COMPLETE, MSG_MAIL_DELIVER } from "../utils/wire-mail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface OfficeArgs {
  action: "start" | "stop" | "list" | "status" | "relay" | "exec" | "join" | "revoke" | "sync" | "connect" | "kill";
  agent?: string;
  command?: string[];
  manifest?: string;
  soundstage?: boolean;
  joinToken?: string;
}

function branchRoot(): string {
  return join(process.env.HOME || homedir(), ".tps", "branch-office");
}

function workspacePath(agentId: string): string {
  // Case 1: agentId is a team (has team.json in its root)
  const teamPath = join(branchRoot(), agentId);
  const teamSidecar = join(teamPath, "team.json");
  if (existsSync(teamSidecar)) {
    return join(teamPath, "workspace");
  }

  // Case 2: agentId is a member of a team
  try {
    const teams = readdirSync(branchRoot()).filter(d => {
      return existsSync(join(branchRoot(), d, "team.json"));
    });

    for (const team of teams) {
      const sidecarPath = join(branchRoot(), team, "team.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      if (Array.isArray(sidecar.members) && sidecar.members.includes(agentId)) {
        return join(branchRoot(), team, "workspace");
      }
    }
  } catch {
    // Fallback to per-agent path on any read error
  }

  return join(branchRoot(), agentId);
}

function sandboxName(agentId: string): string {
  return `tps-agent-${agentId}`;
}

function relayPidFile(agentId: string): string {
  return join(branchRoot(), agentId, "relay.pid");
}

function outboxCounts(agentId: string): { newCount: number; curCount: number; failedCount: number } {
  const root = join(workspacePath(agentId), "mail", "outbox");
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

function resolveSandboxId(agentId: string): string | null {
  const result = spawnSync("nono", ["list", "--json"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    const states = JSON.parse(result.stdout);
    const target = sandboxName(agentId);
    const found = states.find((s: any) => s.name === target);
    return found ? found.id : null;
  } catch {
    return null;
  }
}

export async function runOffice(args: OfficeArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      // ops-17: Check for manifest mode (team provisioning)
      if (args.manifest) {
        try {
          // validateAgent not needed here, provisionTeam takes manifestPath and branchRoot
          provisionTeam(args.manifest, branchRoot());
          console.log(`Team provisioned from manifest.`);
        } catch (e: any) {
          console.error(`Failed to provision team: ${e.message}`);
          process.exit(1);
        }
        return;
      }

      const agent = validateAgent(args.agent);
      const sName = sandboxName(agent);
      const ws = workspacePath(agent);
      mkdirSync(ws, { recursive: true });

      // Load soundstage image if --soundstage was passed
      if (args.soundstage) {
        console.log("🎬 Soundstage mode enabled (Mock LLM, local isolation)");
        const marker = join(branchRoot(), agent, "soundstage.json");
        mkdirSync(join(branchRoot(), agent), { recursive: true });
        writeFileSync(marker, JSON.stringify({ enabled: true, startedAt: new Date().toISOString() }));
        
        const soundstageImage = join(__dirname, "..", "..", "images", "tps-soundstage.tar");
        if (existsSync(soundstageImage)) {
          console.log(`Loading soundstage image: ${soundstageImage}`);
          loadImageIntoSandbox(sName, soundstageImage);
        }
      }

      console.log(`Starting sandbox VM for ${agent}...`);
      spawnSync("nono", ["start", sName, "--mount", `${ws}:/workspace`, "--image", "node:22-alpine"], { stdio: "inherit" });

      if (!waitForSandbox(sName)) {
        console.error("Timed out waiting for sandbox to be ready.");
        process.exit(1);
      }

      console.log(`✓ Sandbox ready for ${agent}.`);
      return;
    }

    case "stop": {
      const agent = validateAgent(args.agent);
      const sName = sandboxName(agent);
      
      // Cleanup soundstage marker if it exists
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      if (existsSync(soundstageMarker)) {
        try { unlinkSync(soundstageMarker); } catch {}
      }

      console.log(`Stopping sandbox VM for ${agent}...`);
      spawnSync("nono", ["stop", sName], { stdio: "inherit" });
      return;
    }

    case "list": {
      const root = branchRoot();
      if (!existsSync(root)) {
        console.log("No branch-office workspaces found.");
        return;
      }
      const agents = readdirSync(root).filter((d) => existsSync(join(root, d)));
      if (agents.length === 0) {
        console.log("No branch-office workspaces found.");
        return;
      }
      for (const a of agents) {
        const sid = resolveSandboxId(a);
        console.log(`- ${a}${sid ? ` (${sid})` : ""}`);
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
      const sid = resolveSandboxId(agent);
      const ws = workspacePath(agent);
      const relayRunning = existsSync(relayPidFile(agent));
      const counts = outboxCounts(agent);
      const sName2 = sandboxName(agent);
      const vmReady = sid ? isSandboxReady(sName2) : false;
      
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      const isSoundstage = existsSync(soundstageMarker);

      console.log(`Agent: ${agent}`);
      console.log(`Workspace: ${ws}`);
      
      if (isSoundstage) {
        console.log(`Mode: 🎬 soundstage (mock LLM, real sandbox)`);
        console.log(`Sandbox: ${sid || "not running"}${vmReady ? " (VM ready)" : ""}`);
      } else {
        console.log(`Sandbox: ${sid || "not running"}${vmReady ? " (VM ready)" : ""}`);
      }
      
      if (sid) console.log(`Socket: ${sandboxSocketPath(sName2)}`);
      console.log(`Relay: ${relayRunning ? "running" : "stopped"}`);
      console.log(`Outbox pending: ${counts.newCount} (cur=${counts.curCount}, failed=${counts.failedCount})`);

      // Check for paused messages (loop detection)
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
      // keep process alive
      setInterval(() => {}, 60_000);
      return;
    }

    case "exec": {
      const agent = validateAgent(args.agent);
      const sName2 = sandboxName(agent);
      const ws = workspacePath(agent);

      if (!isSandboxReady(sName2)) {
        console.error(`Sandbox VM for ${agent} is not ready. Start it with: tps office start ${agent}`);
        process.exit(1);
      }

      const cmd = args.command;
      if (!cmd || cmd.length === 0) {
        console.error("Usage: tps office exec <agent> -- <command...>");
        process.exit(1);
      }

      const result = sandboxExec(sName2, cmd, {
        workspace: ws,
        image: "node:22-alpine",
      });

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }

    case "join": {
      if (!args.agent || !args.joinToken) {
        console.error("Usage: tps office join <name> <join-token>");
        process.exit(1);
      }
      const agent = validateAgent(args.agent);
      const tokenUrl = args.joinToken;
      const url = new URL(tokenUrl);
      if (url.protocol !== "tps:" || url.host !== "join") {
        throw new Error("Invalid join token protocol. Must be tps://join?...");
      }

      const token = {
        host: url.searchParams.get("host")!,
        port: Number(url.searchParams.get("port")),
        transport: (url.searchParams.get("transport") as "ws" | "tcp") || "ws",
        encryptionPubkey: new Uint8Array(Buffer.from(url.searchParams.get("pubkey")!, "base64url")),
        signingPubkey: new Uint8Array(Buffer.from(url.searchParams.get("sigpubkey")!, "base64url")),
        fingerprint: url.searchParams.get("fp")!,
      };

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
      if (existsSync(join(ws, "remote.json"))) {
        try { unlinkSync(join(ws, "remote.json")); } catch {}
      }
      console.log(`Branch '${agent}' revoked.`);
      return;
    }

    case "sync": {
      if (!args.agent) {
        console.error("Usage: tps office sync <name>");
        process.exit(1);
      }
      const { syncRemoteBranch } = await import("../utils/relay.js");
      const { received } = await syncRemoteBranch(args.agent);
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
      // Keep alive
      setInterval(() => {}, 60_000);
      return;
    }

    case "kill": {
      let killed = 0;
      // 1. Kill all active persistent relays
      const { listHostStates, clearHostState } = await import("../utils/connection-state.js");
      const states = listHostStates();
      for (const s of states) {
        try {
          process.kill(s.pid, "SIGTERM");
          clearHostState(s.branch);
          killed++;
        } catch {
          // Might already be dead, clear it anyway
          clearHostState(s.branch);
        }
      }

      // 2. Kill local branch daemon if running
      const { homedir } = require("node:os");
      const { join } = require("node:path");
      const { existsSync, readFileSync, rmSync } = require("node:fs");
      const pidPath = join(process.env.HOME || homedir(), ".tps", "branch", "branch.pid");
      if (existsSync(pidPath)) {
        try {
          const pid = Number(readFileSync(pidPath, "utf-8").trim());
          process.kill(pid, "SIGTERM");
          killed++;
        } catch {}
        try { rmSync(pidPath, { force: true }); } catch {}
      }

      console.log(`Kill switch engaged. Terminated ${killed} TPS process(es).`);
      break;
    }
  }
}
