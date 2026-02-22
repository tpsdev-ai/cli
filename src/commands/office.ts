import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, copyFileSync } from "node:fs";
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
import { MSG_JOIN_COMPLETE } from "../utils/wire-mail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface OfficeArgs {
  action: "start" | "stop" | "list" | "status" | "relay" | "exec" | "join" | "revoke" | "sync" | "connect";
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
  return join(process.env.HOME || homedir(), ".tps", "branch-office");
}

function validateAgent(agent?: string): string {
  if (!agent) {
    console.error("Agent is required.");
    process.exit(1);
  }
  const safe = sanitizeIdentifier(agent);
  if (safe !== agent) {
    console.error(`Invalid agent id: ${agent}`);
    process.exit(1);
  }
  return agent;
}

export function parseJoinToken(token: string): {
  host: string;
  port: number;
  transport: "ws" | "tcp";
  encryptionPubkey: Uint8Array;
  signingPubkey: Uint8Array;
  fingerprint: string;
} {
  let u: URL;
  try {
    u = new URL(token);
  } catch {
    throw new Error("Invalid join token URL");
  }
  if (u.protocol !== "tps:") throw new Error("Join token must use tps:// scheme");

  const host = u.searchParams.get("host") || "";
  const portRaw = u.searchParams.get("port") || "";
  const transportRaw = u.searchParams.get("transport") || "ws";
  const pubkeyRaw = u.searchParams.get("pubkey") || "";
  const sigRaw = u.searchParams.get("sigpubkey") || "";
  const fp = u.searchParams.get("fp") || "";

  if (!host) throw new Error("Join token missing host");
  const transport = transportRaw === "tcp" ? "tcp" : "ws";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("Join token has invalid port");
  }
  if (!pubkeyRaw) throw new Error("Join token missing pubkey");
  if (!sigRaw) throw new Error("Join token missing sigpubkey");
  if (!fp) throw new Error("Join token missing fingerprint");

  let encryptionPubkey: Uint8Array;
  let signingPubkey: Uint8Array;
  try {
    encryptionPubkey = new Uint8Array(Buffer.from(pubkeyRaw, "base64url"));
    signingPubkey = new Uint8Array(Buffer.from(sigRaw, "base64url"));
  } catch {
    throw new Error("Join token contains invalid key encoding");
  }
  if (encryptionPubkey.length !== 32) throw new Error("Join token encryption pubkey must be 32 bytes");
  if (signingPubkey.length !== 32) throw new Error("Join token signing pubkey must be 32 bytes");

  const normalizedFp = fp.startsWith("sha256:") ? fp : `sha256:${fp}`;
  const expected = `sha256:${fingerprint(signingPubkey)}`;
  if (expected !== normalizedFp) {
    throw new Error("Join token fingerprint does not match signing key");
  }

  return { host, port, transport, encryptionPubkey, signingPubkey, fingerprint: normalizedFp };
}

function workspacePath(agent: string): string {
  return join(branchRoot(), agent);
}

function sandboxName(agent: string): string {
  return `tps-${agent}`;
}

function sandboxAgent(): string {
  const raw = process.env.TPS_SANDBOX_AGENT || "claude";
  const safe = sanitizeIdentifier(raw);
  if (safe !== raw) {
    throw new Error(`Invalid sandbox agent: ${raw}`);
  }
  return raw;
}

function idFile(agent: string): string {
  return join(workspacePath(agent), "sandbox.id");
}

function relayPidFile(agent: string): string {
  return join(workspacePath(agent), "relay.pid");
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
  // Security: never source bootstrap from process.cwd().
  // Use the trusted in-code template to avoid cwd injection.
  // ops-15.5: Don't overwrite existing bootstrap.sh if user customized it.
  if (!existsSync(bootstrap)) {
    const template = BOOTSTRAP_TEMPLATE.replaceAll("__WORKSPACE__", ws);
    writeFileSync(bootstrap, template, { mode: 0o755 });
  } else {
    console.log("Using existing bootstrap.sh");
  }

  return ws;
}

function resolveSandboxId(agent: string): string | null {
  const sid = idFile(agent);
  if (existsSync(sid)) {
    return readFileSync(sid, "utf-8").trim();
  }

  const listed = spawnSync("docker", ["sandbox", "ls", "--json"], { encoding: "utf-8" });
  if (listed.status !== 0) return null;

  try {
    const parsed = JSON.parse(listed.stdout || "{}") as { vms?: Array<{ name?: string; id?: string; sandboxId?: string }> };
    const rows = parsed.vms || [];
    const expected = sandboxName(agent).toLowerCase();
    const match = rows.find((r) => (r.name || "").toLowerCase() === expected);
    if (!match) return null;
    return (match.name || match.id || match.sandboxId || null) as string | null;
  } catch {
    return null;
  }
}

function relayLogFile(agent: string): string {
  return join(workspacePath(agent), "relay.log");
}

function startRelayProcess(agent: string): void {
  const pidFile = relayPidFile(agent);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    try {
      // Check if process exists (signal 0)
      process.kill(pid, 0);
      console.log(`Relay already running (pid ${pid})`);
      return;
    } catch {
      // Process dead, proceed to spawn new one
    }
  }

  const logPath = relayLogFile(agent);
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1]!, "office", "relay", agent], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  // Close the fd in the parent so we don't hold it open (child has it now)
  // Wait, spawn with detached doesn't automatically close fds in parent?
  // Actually, passing fd to stdio options duplicates it to child. Parent can close.
  // But we need to be careful not to close it before spawn uses it? Spawn is synchronous in setup.
  // Node docs say: "The file descriptor is duplicated in the child process."
  // Safe to close in parent after spawn returns.
  try { closeSync(logFd); } catch {}
  writeFileSync(relayPidFile(agent), `${child.pid}\n`, "utf-8");
}

function stopRelayProcess(agent: string): void {
  const pf = relayPidFile(agent);
  if (!existsSync(pf)) return;
  const pid = Number(readFileSync(pf, "utf-8").trim());
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already stopped
    }
  }
}

function outboxCounts(agent: string): { newCount: number; curCount: number; failedCount: number } {
  const ws = workspacePath(agent);
  const outNew = join(ws, "mail", "outbox", "new");
  const outCur = join(ws, "mail", "outbox", "cur");
  const outFailed = join(ws, "mail", "outbox", "failed");
  const newCount = existsSync(outNew) ? readdirSync(outNew).filter((f) => f.endsWith(".json")).length : 0;
  const curCount = existsSync(outCur) ? readdirSync(outCur).filter((f) => f.endsWith(".json")).length : 0;
  const failedCount = existsSync(outFailed) ? readdirSync(outFailed).filter((f) => f.endsWith(".json")).length : 0;
  return { newCount, curCount, failedCount };
}

export async function runOffice(args: OfficeArgs): Promise<void> {
  switch (args.action) {
    case "join": {
      const agent = validateAgent(args.agent);
      if (!args.joinToken) {
        console.error("Usage: tps office join <name> <join-token-url>");
        process.exit(1);
      }

      const token = parseJoinToken(args.joinToken);
      const existing = lookupBranch(agent);
      if (existing) {
        console.error(`Branch '${agent}' is already registered. Revoke first or use a different name.`);
        process.exit(1);
      }

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

      const hostKp = loadHostIdentity();
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
      console.log("Remote branch office ready.");
      return;
    }

    case "start": {
      const agent = validateAgent(args.agent);

      // ops-17: Check for manifest mode (team provisioning)
      if (args.manifest) {
        try {
          provisionTeam(args.manifest, branchRoot());
          console.log(`Team '${agent}' provisioned from manifest.`);
        } catch (e: any) {
          console.error(`Failed to provision team: ${e.message}`);
          process.exit(1);
        }
      }

      const ws = setupWorkspace(agent);

      if (args.soundstage) {
        // Write soundstage marker OUTSIDE workspace mount (agents can't detect it)
        const teamRoot = join(branchRoot(), agent);
        const marker = {
          mode: "soundstage",
          createdAt: new Date().toISOString(),
          agent,
          manifest: args.manifest || null,
          mockLlmPort: 11434,
        };
        // Use teamRoot instead of ws to place outside workspace
        writeFileSync(join(teamRoot, "soundstage.json"), JSON.stringify(marker, null, 2), "utf-8");

        // Rewrite openclaw.json to point at mock LLM
        const configPath = join(ws, ".openclaw", "openclaw.json");
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          if (config.agents?.defaults?.model) {
            config.agents.defaults.model.primary = "openai-compatible/mock-soundstage";
            config.agents.defaults.model.fallbacks = [];
          }
          // Add base URL for the mock
          config.agents = config.agents || {};
          config.agents.defaults = config.agents.defaults || {};
          config.agents.defaults.baseUrl = "http://127.0.0.1:11434/v1";
          writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        }

        // Copy mock LLM server into team root (NOT workspace — agents can't modify it)
        const mockSrc = join(__dirname, "..", "soundstage", "mock-llm.js");
        const mockDst = join(teamRoot, "mock-llm.js");
        if (!existsSync(mockSrc)) {
          throw new Error("Soundstage mock LLM not found. Run `bun run build` first.");
        }
        copyFileSync(mockSrc, mockDst);

        // Substitute __TEAM_ROOT__ in bootstrap (setupWorkspace only handles __WORKSPACE__)
        const bootstrapPath = join(ws, "bootstrap.sh");
        if (existsSync(bootstrapPath)) {
          const bs = readFileSync(bootstrapPath, "utf-8").replaceAll("__TEAM_ROOT__", teamRoot);
          writeFileSync(bootstrapPath, bs, { mode: 0o755 });
        }
      }

      const sName = sandboxName(agent);
      const skipVm = process.env.TPS_OFFICE_SKIP_VM === "1";

      if (!skipVm) {
        // Idempotency: check if sandbox already exists
        const existingId = resolveSandboxId(agent);

        if (!existingId) {
          const sAgent = sandboxAgent();
          console.log(`Creating sandbox ${sName}...`);
          // docker sandbox create hangs indefinitely (v0.11.0 bug) even after
          // the VM is ready. Spawn it in the background and wait for the socket.
          const createLog = join(ws, "create.log");
          const createLogFd = openSync(createLog, "a");
          const createArgs = ["sandbox", "create", "--name", sName];
          // Soundstage uses a pre-built image with openclaw already installed
          if (args.soundstage) {
            createArgs.push("--template", "tps-soundstage:latest");
          }
          createArgs.push(sAgent, ws);
          const createChild = spawn("docker", createArgs, {
            detached: true,
            stdio: ["ignore", createLogFd, createLogFd],
          });
          createChild.unref();
          try { closeSync(createLogFd); } catch {}

          // Wait for VM socket to appear (the create command keeps running but VM is ready)
          console.log("Waiting for sandbox VM to boot...");
          if (!waitForSandbox(sName, 90000)) {
            // Check if sandbox appeared in ls even if socket isn't ready
            const check = spawnSync("docker", ["sandbox", "ls", "--json"], { encoding: "utf-8" });
            const vms = JSON.parse(check.stdout || "{}").vms || [];
            const found = vms.find((v: any) => v.name === sName);
            if (!found) {
              console.error(`Sandbox creation failed. Check ${createLog}`);
              process.exit(1);
            }
            // VM exists but socket not ready — wait longer
            console.log("VM created, waiting for daemon...");
            if (!waitForSandbox(sName, 30000)) {
              console.error("Sandbox VM daemon did not become ready.");
              process.exit(1);
            }
          }
          console.log("Sandbox VM ready.");
        }
      }

      const id = sName;
      writeFileSync(idFile(agent), `${id}\n`, "utf-8");

      const sock = sandboxSocketPath(id);

      if (!skipVm) {
        // Ensure VM is ready (may already be if we just created it above)
        if (!isSandboxReady(id)) {
          console.log("Waiting for sandbox VM...");
          if (!waitForSandbox(id, 60000)) {
            console.error("Sandbox VM did not become ready in 60s.");
            process.exit(1);
          }
        }

        // Load base image for bootstrap execution
        console.log("Loading base image into sandbox...");
        if (!loadImageIntoSandbox(id, "node:22-alpine")) {
          if (!loadImageIntoSandbox(id, "alpine:latest")) {
            console.error("Failed to load base image into sandbox VM.");
            process.exit(1);
          }
        }

        // Execute bootstrap via direct socket (workaround for docker sandbox exec bug)
        console.log("Running bootstrap...");
        const exec = sandboxExec(id, ["sh", join(ws, "bootstrap.sh")], {
          workspace: ws,
          image: "node:22-alpine",
        });
        if (exec.status !== 0) {
          const fallback = sandboxExec(id, ["sh", join(ws, "bootstrap.sh")], {
            workspace: ws,
            image: "alpine:latest",
          });
          if (fallback.status !== 0) {
            console.error(fallback.stderr || fallback.stdout || "Bootstrap failed.");
            process.exit(1);
          }
        }
      }

      if (process.env.TPS_OFFICE_SKIP_RELAY !== "1") {
        startRelayProcess(agent);
      }

      console.log(`Sandbox started for ${agent}`);
      console.log(`ID: ${id}`);
      console.log(`Socket: ${sock}`);
      console.log(`Workspace: ${ws}`);
      return;
    }

    case "stop": {
      const agent = validateAgent(args.agent);
      stopRelayProcess(agent);
      const id = resolveSandboxId(agent);
      if (!id) {
        console.error(`No sandbox found for agent: ${agent}`);
        process.exit(1);
      }
      const stop = spawnSync("docker", ["sandbox", "stop", id], { encoding: "utf-8" });
      if (stop.status !== 0) {
        console.error(stop.stderr || stop.stdout || `Failed to stop sandbox ${id}.`);
        process.exit(1);
      }
      console.log(`Stopped sandbox ${id} (${agent})`);
      return;
    }

    case "revoke": {
      const agent = validateAgent(args.agent);
      const existing = lookupBranch(agent);
      if (!existing) {
        console.error(`Branch '${agent}' not found in registry.`);
        process.exit(1);
      }
      revokeBranch(agent, "manual revocation");
      console.log(`Branch '${agent}' revoked. Run 'tps branch init' on the remote to re-join.`);
      return;
    }

    case "sync": {
      const agent = validateAgent(args.agent);
      const result = await syncRemoteBranch(agent);
      console.log(`Sync complete. Received ${result.received} message(s) from ${agent}.`);
      return;
    }

    case "connect": {
      const agent = validateAgent(args.agent);
      console.log(`Connecting to ${agent}... (Ctrl-C to stop)`);
      const cleanup = await connectAndKeepAlive(agent);
      const shutdown = async () => {
        await cleanup();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      await new Promise(() => {});
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
  }
}
