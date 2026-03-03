/**
 * tps agent — Agent lifecycle and TPS runtime management.
 *
 * Subcommands:
 *   create   Provision a new agent: generate keys, register in Flair, write config
 *   run      Single-shot: process one message and exit
 *   start    Long-running daemon: poll mail, process, respond
 *   health   Print "healthy" / "unhealthy"
 *   list     Show registered agents in Flair
 *   status   Show status of a running agent (PID, last activity, Flair memory count)
 */

import { AgentRuntime, loadAgentConfig } from "@tpsdev-ai/agent";
import { generateKeyPair, saveKeyPair, loadKeyPair } from "../utils/identity.js";
import { createFlairClient } from "../utils/flair-client.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findNono, runCommandUnderNono, isNonoStrict } from "../utils/nono.js";

export interface AgentArgs {
  action: "run" | "start" | "health" | "create" | "list" | "status";
  config?: string;
  message?: string;
  /** For create/list/status */
  displayName?: string;
  soulFile?: string;
  noSeed?: boolean;
  starterMemories?: Array<{ content: string; tags?: string[]; durability?: string }>;
  id?: string;
  name?: string;
  model?: string;
  flairUrl?: string;
  json?: boolean;
  sandbox?: boolean;
  /** Internal: set by re-exec under nono, skips re-wrapping */
  sandboxed?: boolean;
}

// ─── create ──────────────────────────────────────────────────────────────────

async function loadSoulFile(filePath: string): Promise<Record<string, string>> {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(filePath, "utf8");
  // Support simple KEY: value YAML or JSON
  if (filePath.endsWith(".json")) return JSON.parse(raw);
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

async function createAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent create --id <agent-id> [--name <display-name>] [--model <provider/model>]");
    process.exit(1);
  }

  const name = args.name ?? id;
  const model = args.model ?? "anthropic/claude-sonnet-4-6";
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const identityDir = join(homedir(), ".tps", "identity");
  const keyPrefix = id;

  mkdirSync(identityDir, { recursive: true });

  // 1. Generate Ed25519 keys
  const keyPath = join(identityDir, `${keyPrefix}.key`);
  const pubPath = join(identityDir, `${keyPrefix}.pub`);

  let pubKeyHex: string;

  if (existsSync(keyPath) && existsSync(pubPath)) {
    console.log(`  Keys already exist at ${keyPath}`);
    const kp = loadKeyPair(identityDir, keyPrefix);
    pubKeyHex = Buffer.from(kp.signing.publicKey).toString("hex");
  } else {
    console.log(`  Generating Ed25519 keys for ${id}...`);
    const kp = generateKeyPair();
    saveKeyPair(kp, identityDir, keyPrefix);
    pubKeyHex = Buffer.from(kp.signing.publicKey).toString("hex");
    console.log(`  Keys saved to ${identityDir}/`);
  }

  // 2. Register in Flair
  const flair = createFlairClient(id, flairUrl);
  const online = await flair.ping();

  if (!online) {
    console.warn(`  ⚠️  Flair not reachable at ${flairUrl} — skipping registration.`);
    console.warn(`  Run setup-harper.sh and retry: tps agent create --id ${id}`);
  } else {
    const existing = await flair.getAgent(id);
    if (existing) {
      console.log(`  Agent '${id}' already registered in Flair.`);
      // Still register real public key if record has placeholder
      if (existing.publicKey === "pending") {
        await flair.updateAgent(id, { publicKey: pubKeyHex }).catch(() => {});
      }
    } else if (!args.noSeed) {
      // Seed agent with soul + starter memories
      const soulTemplate = args.soulFile
        ? await loadSoulFile(args.soulFile)
        : undefined;
      const starterMemories = args.starterMemories;
      try {
        const seeded = await flair.seedAgent({
          agentId: id,
          displayName: name,
          role: "agent",
          soulTemplate,
          starterMemories,
        });
        // Update the public key on the agent record that AgentSeed created
        await flair.updateAgent(id, { publicKey: pubKeyHex }).catch(() => {});
        console.log(`  Agent seeded: ${seeded.soulEntries.length} soul entries, ${seeded.memories.length} memories.`);
      } catch (_e: any) {
        // AgentSeed requires admin auth — fall back to direct registration
        await flair.registerAgent(name, pubKeyHex).catch(() => {});
        console.log(`  Agent '${id}' registered in Flair (no seed — not admin).`);
      }
    } else {
      // --no-seed: just register
      await flair.registerAgent(name, pubKeyHex);
      console.log(`  Agent '${id}' registered in Flair (seeding skipped).`);
    }
  }

  // 3. Write agent config
  const agentsDir = join(homedir(), ".tps", "agents", id);
  mkdirSync(agentsDir, { recursive: true });

  const configPath = join(agentsDir, "agent.yaml");
  const mailDir = join(homedir(), ".tps", "mail");
  const memoryPath = join(agentsDir, "memory.jsonl");
  const workspace = join(homedir(), "ops");

  const [provider, ...modelParts] = model.split("/");
  const modelName = modelParts.join("/");

  const config = `# TPS Agent config for ${id}
agentId: ${id}
name: ${name}
workspace: ${workspace}
mailDir: ${mailDir}
memoryPath: ${memoryPath}
contextWindowTokens: 200000

llm:
  provider: ${provider || "anthropic"}
  model: ${modelName || model}
  # API key is loaded from environment — never store in config
  # For sandbox: point to LLM proxy at localhost
  # baseUrl: http://localhost:6459

tools:
  - read
  - write
  - edit
  - exec
  - mail
`;

  writeFileSync(configPath, config, "utf-8");
  console.log(`  Config written to ${configPath}`);

  console.log(`\n✅ Agent '${id}' is ready.`);
  console.log(`   Run:  tps agent start --id ${id}`);
  console.log(`   Or:   tps agent run --id ${id} --message "hello"`);
}

// ─── list ─────────────────────────────────────────────────────────────────────

async function listAgents(args: AgentArgs): Promise<void> {
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  // List local agent configs
  const agentsDir = join(homedir(), ".tps", "agents");

  if (!existsSync(agentsDir)) {
    console.log("No agents provisioned yet. Run: tps agent create --id <agent-id>");
    return;
  }

  const ids = readdirSync(agentsDir);
  if (ids.length === 0) {
    console.log("No agents found.");
    return;
  }

  const results: Array<{ id: string; name: string; flair: string; pid: string }> = [];

  for (const id of ids) {
    const configPath = join(agentsDir, id, "agent.yaml");
    if (!existsSync(configPath)) continue;

    let name = id;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const m = raw.match(/^name:\s*(.+)$/m);
      if (m) name = m[1].trim();
    } catch {}

    // Check Flair registration
    let flairStatus = "unknown";
    try {
      const flair = createFlairClient(id, flairUrl);
      const online = await flair.ping();
      if (!online) {
        flairStatus = "offline";
      } else {
        const agent = await flair.getAgent(id);
        flairStatus = agent ? "registered" : "not registered";
      }
    } catch {
      flairStatus = "error";
    }

    // Check PID
    const pidPath = join(agentsDir, id, "run.pid");
    let pidStatus = "stopped";
    if (existsSync(pidPath)) {
      try {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        process.kill(pid, 0); // throws if not running
        pidStatus = `running (pid ${pid})`;
      } catch {
        pidStatus = "stopped (stale pid)";
      }
    }

    results.push({ id, name, flair: flairStatus, pid: pidStatus });
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.id} (${r.name})`);
      console.log(`  Flair: ${r.flair}`);
      console.log(`  Process: ${r.pid}`);
    }
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

async function agentStatus(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent status --id <agent-id>");
    process.exit(1);
  }

  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const agentDir = join(homedir(), ".tps", "agents", id);
  const configPath = join(agentDir, "agent.yaml");

  if (!existsSync(configPath)) {
    console.error(`Agent '${id}' not found. Run: tps agent create --id ${id}`);
    process.exit(1);
  }

  const out: Record<string, unknown> = { id };

  // Process status
  const pidPath = join(agentDir, "run.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      out.process = { running: true, pid };
    } catch {
      out.process = { running: false, stalePid: true };
    }
  } else {
    out.process = { running: false };
  }

  // Flair status
  try {
    const flair = createFlairClient(id, flairUrl);
    const online = await flair.ping();
    if (!online) {
      out.flair = { online: false };
    } else {
      const agent = await flair.getAgent(id);
      const memories = await flair.listMemories(100).catch(() => []);
      out.flair = {
        online: true,
        registered: !!agent,
        memoryCount: memories.length,
      };
    }
  } catch (e) {
    out.flair = { online: false, error: String(e) };
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const proc = out.process as { running: boolean; pid?: number; stalePid?: boolean };
    const flair = out.flair as { online: boolean; registered?: boolean; memoryCount?: number };
    console.log(`Agent: ${id}`);
    console.log(`Process: ${proc.running ? `running (pid ${proc.pid})` : proc.stalePid ? "stopped (stale pid)" : "stopped"}`);
    console.log(`Flair: ${flair.online ? (flair.registered ? `registered, ${flair.memoryCount} memories` : "not registered") : "offline"}`);
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runAgent(args: AgentArgs): Promise<void> {
  switch (args.action) {
    case "create":
      return createAgent(args);

    case "list":
      return listAgents(args);

    case "status":
      return agentStatus(args);

    case "run":
    case "start":
    case "health": {
      // Resolve config path — support --id shorthand
      let configPath = args.config;
      if (!configPath && args.id) {
        configPath = join(homedir(), ".tps", "agents", args.id, "agent.yaml");
      }
      if (!configPath) {
        console.error("Usage: tps agent run --id <agent-id> --message <text>");
        console.error("   or: tps agent run --config <path> --message <text>");
        process.exit(1);
      }
      if (!existsSync(configPath)) {
        console.error(`Config not found: ${configPath}`);
        console.error(`Run 'tps agent create --id ${args.id ?? "<id>"}' first.`);
        process.exit(1);
      }

      const config = loadAgentConfig(configPath);
      const runtime = new AgentRuntime(config);

      if (args.action === "run") {
        const message = args.message || process.env.TPS_AGENT_MESSAGE;
        if (!message) {
          console.error("Usage: tps agent run --id <agent-id> --message <text>");
          process.exit(1);
        }
        await runtime.runOnce(message);
        return;
      }

      if (args.action === "start") {
        const sandbox = (args as any).sandbox ?? false;
        const sandboxed = (args as any).sandboxed ?? false;
        const nonoAvailable = findNono();

        if (sandboxed) {
          // Already running inside nono — skip re-exec, proceed to runtime
        } else if (sandbox || isNonoStrict()) {
          if (!nonoAvailable) {
            if (isNonoStrict()) {
              console.error("❌ --sandbox requires nono (TPS_NONO_STRICT=1). Install from https://nono.sh");
              process.exit(1);
            }
            console.warn("⚠️  nono not found — starting WITHOUT sandbox isolation. Pass --sandbox after installing nono.");
          } else {
            // Re-exec this process under nono with tps-agent-run profile
            const identityDir = join(homedir(), ".tps", "identity");
            const mailDir = join(homedir(), ".tps", "mail");
            const agentDir = join(homedir(), ".tps", "agents", config.agentId);
            const bunDir = join(homedir(), ".bun");
            const tmpDir = process.env.TMPDIR ?? "/tmp";
            const exitCode = runCommandUnderNono(
              "tps-agent-run",
              {
                workdir: config.workspace,
                // System-wide read: bun needs macOS dylibs/frameworks, read-only is safe
                read: [identityDir, agentDir, bunDir, "/"],
                allow: [mailDir, tmpDir, config.workspace],
              },
              [process.execPath, ...process.execArgv, process.argv[1]!, "agent", "start", "--id", config.agentId, "--sandboxed"],
            );
            process.exit(exitCode);
          }
        } else if (!sandboxed && nonoAvailable) {
          console.log(`ℹ️  nono available — pass --sandbox to run with isolation`);
        }

        try {
          await runtime.start();
        } catch (_err) {
          console.error("❌ Agent runtime crashed:", _err);
          process.exit(1);
        }
        return;
      }

      if (args.action === "health") {
        const healthy = runtime.isHealthy();
        process.stdout.write(healthy ? "healthy\n" : "unhealthy\n");
        process.exit(healthy ? 0 : 1);
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown agent action: ${_}`);
      process.exit(1);
    }
  }
}
