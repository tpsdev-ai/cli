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
import { connectAndKeepAlive, startRelay, syncRemoteBranch } from "../utils/relay.js";
import { isSandboxReady, loadImageIntoSandbox, sandboxExec, sandboxSocketPath, waitForSandbox } from "../utils/sandbox.js";
import { MSG_JOIN_COMPLETE, MSG_MAIL_DELIVER } from "../utils/wire-mail.js";
import { WsNoiseTransport } from "../utils/ws-noise-transport.js";
import { branchRoot as sharedBranchRoot, resolveTeamId, workspacePath as sharedWorkspacePath } from "../utils/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface OfficeArgs {
  action: "start" | "stop" | "list" | "status" | "relay" | "exec" | "join" | "revoke" | "sync" | "connect" | "kill";
  agent?: string;
  command?: string[];
  manifest?: string;
  soundstage?: boolean;
  joinToken?: string;
}

const BOOTSTRAP_TEMPLATE = `#!/bin/bash
set -e

# Install dependencies (skip if already available, e.g., soundstage image)
if ! command -v openclaw >/dev/null 2>&1; then
  npm install -g openclaw || { echo "ERROR: openclaw install failed"; exit 1; }
  npm install -g @tpsdev-ai/cli || echo "TPS not on npm yet, skipping"
fi

openclaw --version

# Detect config location
# Standard branch office: workspace/.openclaw/openclaw.json
# Multi-agent office: team-root/.openclaw/openclaw.json (workspace is a subdir)
if [ -f "__WORKSPACE__/.openclaw/openclaw.json" ]; then
  CONFIG="__WORKSPACE__/.openclaw/openclaw.json"
elif [ -f "__WORKSPACE__/../.openclaw/openclaw.json" ]; then
  CONFIG="__WORKSPACE__/../.openclaw/openclaw.json"
else
  echo "No openclaw.json found"
  exit 1
fi

echo "Starting gateway with config: $CONFIG"

# If mock LLM script exists, start it (soundstage mode)
# mock-llm.js lives in team root (outside workspace) so agents can't modify it
if [ -f "__TEAM_ROOT__/mock-llm.js" ]; then
  echo "Starting mock LLM (soundstage mode)..."
  nohup node __TEAM_ROOT__/mock-llm.js > __TEAM_ROOT__/mock-llm.log 2>&1 &
  sleep 1
fi

# Run gateway in background (nohup to survive shell exit)
nohup openclaw gateway run --config "$CONFIG" > __WORKSPACE__/gateway.log 2>&1 &
echo "Branch office agent ready (gateway pid $!)"
`;

function branchRoot(): string {
  return sharedBranchRoot();
}

function workspacePath(agentId: string): string {
  return sharedWorkspacePath(agentId);
}

function sandboxName(agentId: string): string {
  const teamId = resolveTeamId(agentId);
  return `tps-agent-${teamId}`;
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

  const bootstrap = join(ws, "bootstrap.sh");
  if (!existsSync(bootstrap)) {
    const teamRoot = join(branchRoot(), agent);
    const template = BOOTSTRAP_TEMPLATE
      .replaceAll("__WORKSPACE__", ws)
      .replaceAll("__TEAM_ROOT__", teamRoot);
    writeFileSync(bootstrap, template, { mode: 0o755 });
  } else {
    console.log("Using existing bootstrap.sh");
  }

  return ws;
}

export async function runOffice(args: OfficeArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      if (args.manifest) {
        try {
          provisionTeam(args.manifest, branchRoot());
          if (args.soundstage && args.agent) {
            const team = validateAgent(args.agent);
            const teamRoot = join(branchRoot(), team);
            const ws = join(teamRoot, "workspace");
            const marker = join(teamRoot, "soundstage.json");
            mkdirSync(teamRoot, { recursive: true });
            writeFileSync(marker, JSON.stringify({ enabled: true, startedAt: new Date().toISOString() }));

            const teamBootstrap = join(teamRoot, "bootstrap.sh");
            let bs = BOOTSTRAP_TEMPLATE
              .replaceAll("__WORKSPACE__", ws)
              .replaceAll("__TEAM_ROOT__", teamRoot);
            const workspaceBootstrap = join(ws, "bootstrap.sh");
            if (existsSync(workspaceBootstrap)) {
              bs = readFileSync(workspaceBootstrap, "utf-8").replaceAll("__TEAM_ROOT__", teamRoot);
            }
            writeFileSync(teamBootstrap, bs, { mode: 0o755 });
          }
          console.log(`Team provisioned from manifest.`);
        } catch (e: any) {
          console.error(`Failed to provision team: ${e.message}`);
          process.exit(1);
        }
        return;
      }

      const agent = validateAgent(args.agent);
      const sName = sandboxName(agent);
      const ws = setupWorkspace(agent);

      if (args.soundstage) {
        console.log("🎬 Soundstage mode enabled (Mock LLM, local isolation)");
        const teamRoot = join(branchRoot(), agent);
        const marker = join(teamRoot, "soundstage.json");
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(marker, JSON.stringify({ enabled: true, startedAt: new Date().toISOString() }));
        
        const soundstageImage = join(__dirname, "..", "..", "images", "tps-soundstage.tar");
        if (existsSync(soundstageImage)) {
          console.log(`Loading soundstage image: ${soundstageImage}`);
          loadImageIntoSandbox(sName, soundstageImage);
        }

        const bootstrap = join(ws, "bootstrap.sh");
        if (existsSync(bootstrap)) {
          const bs = readFileSync(bootstrap, "utf-8").replaceAll("__TEAM_ROOT__", teamRoot);
          writeFileSync(bootstrap, bs, { mode: 0o755 });
        }
      }

      const teamId = resolveTeamId(agent);
      const isTeam = teamId !== agent;
      if (isTeam) {
        console.log(`(Shared team sandbox: ${teamId})`);
      }

      if (process.env.TPS_OFFICE_SKIP_VM === "1") {
        console.log(`✓ Sandbox ready for ${agent} (SKIPPED).`);
        return;
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
      const soundstageMarker = join(branchRoot(), agent, "soundstage.json");
      if (existsSync(soundstageMarker)) {
        try { unlinkSync(soundstageMarker); } catch {}
      }

      const sid = resolveSandboxId(agent);
      if (!sid) {
        process.stderr.write("No sandbox found for agent\n");
        process.exit(1);
      }

      console.log(`Stopping sandbox VM for ${agent}...`);
      const stopResult = spawnSync("nono", ["stop", sName], { stdio: "inherit" });
      if (stopResult.status !== 0) {
        process.exit(stopResult.status ?? 1);
      }
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
      }
      console.log(`Sandbox: ${sid || "not running"}${vmReady ? " (VM ready)" : ""}`);
      
      if (sid) console.log(`Socket: ${sandboxSocketPath(sName2)}`);
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
