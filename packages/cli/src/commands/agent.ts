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
import yaml from "js-yaml";
import { generateKeyPair, saveKeyPair, loadKeyPair } from "../utils/identity.js";
import { createFlairClient } from "../utils/flair-client.js";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { accessSync, constants, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findNono, runCommandUnderNono, isNonoStrict } from "../utils/nono.js";

export interface AgentArgs {
  action: "run" | "start" | "health" | "create" | "list" | "status" | "decommission" | "commit" | "isolate" | "logs" | "healthcheck";
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
  verbose?: boolean;
  force?: boolean;
  port?: number;
  repo?: string;
  branchName?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
  paths?: string[];
  push?: boolean;
  prTitle?: string;
  sandbox?: boolean;
  /** Internal: set by re-exec under nono, skips re-wrapping */
  sandboxed?: boolean;
  lines?: number;
  follow?: boolean;
}

interface AgentHealthcheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

function healthcheckHomeDir(): string {
  return process.env.TPS_HOME ?? homedir();
}

function agentHomeDir(): string {
  return process.env.TPS_HOME ?? homedir();
}

function archivePath(path: string, timestamp: string): string {
  return `${path}.archived-${timestamp}`;
}

function archiveIfExists(path: string, timestamp: string): string | null {
  if (!existsSync(path)) return null;
  const archived = archivePath(path, timestamp);
  renameSync(path, archived);
  return archived;
}

async function confirmDecommission(agentId: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Refusing to prompt without a TTY. Re-run with --force to skip confirmation.");
    process.exit(1);
  }

  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Decommission agent '${agentId}'? This archives local state and marks the Flair agent decommissioned. Type '${agentId}' to continue: `,
    );
    if (answer.trim() !== agentId) {
      console.error("Decommission cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function normalizeLogLineCount(lines?: number): number {
  if (lines === undefined) return 50;
  if (!Number.isInteger(lines) || lines <= 0) {
    console.error(`--lines must be a positive integer. Got: ${lines}`);
    process.exit(1);
  }
  return lines;
}

function tailLines(content: string, count: number): string[] {
  if (!content) return [];
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  return lines.slice(-count);
}

async function streamLogUpdates(logPath: string, offset: number): Promise<never> {
  let position = offset;
  let reading = false;
  let pending = false;

  const readFromPosition = (): void => {
    if (reading) {
      pending = true;
      return;
    }

    const size = statSync(logPath).size;
    if (size < position) {
      position = 0;
    }
    if (size === position) return;

    reading = true;
    const stream = createReadStream(logPath, {
      encoding: "utf-8",
      start: position,
      end: size - 1,
    });

    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    stream.on("end", () => {
      position = size;
      reading = false;
      if (pending) {
        pending = false;
        readFromPosition();
      }
    });

    stream.on("error", () => {
      reading = false;
    });
  };

  await new Promise<never>(() => {
    const watcher = watch(logPath, { persistent: true }, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        readFromPosition();
      }
    });

    const handleSigint = (): void => {
      watcher.close();
      process.removeListener("SIGINT", handleSigint);
      process.stdout.write("\n");
      process.exit(0);
    };

    process.on("SIGINT", handleSigint);
  });

  process.exit(0);
}

async function logAgentRuntime(args: AgentArgs): Promise<void> {
  const agentId = args.id;
  if (!agentId) {
    console.error("Usage: tps agent logs --id <agent-id> [--lines <N>] [--follow|-f]");
    process.exit(1);
  }

  const lineCount = normalizeLogLineCount(args.lines);
  const logPath = join(healthcheckHomeDir(), ".tps", "agents", agentId, "session.log");
  if (!existsSync(logPath)) {
    console.error(`No log file found for ${agentId}`);
    process.exit(1);
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = tailLines(content, lineCount);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

  if (args.follow) {
    await streamLogUpdates(logPath, statSync(logPath).size);
  }
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
  const flair = createFlairClient(id, flairUrl, keyPath);
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
      const flair = createFlairClient(id, flairUrl, join(homedir(), ".tps", "identity", `${id}.key`));
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

  const homeDir = agentHomeDir();
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const agentDir = join(homeDir, ".tps", "agents", id);
  const configPath = join(agentDir, "agent.yaml");

  if (!existsSync(configPath)) {
    console.error(`Agent '${id}' not found. Run: tps agent create --id ${id}`);
    process.exit(1);
  }

  const config = loadAgentConfig(configPath);
  const rawConfig = (yaml.load(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
  const runtime = typeof rawConfig.runtime === "string" ? rawConfig.runtime : undefined;
  const out: Record<string, unknown> = { id };

  if (args.verbose) {
    out.config = {
      workspace: config.workspace,
      runtime: runtime ?? "unknown",
      model: config.llm.model,
      mailDir: config.mailDir,
    };
  }

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
    const flair = createFlairClient(id, flairUrl, join(homeDir, ".tps", "identity", `${id}.key`));
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
    if (args.verbose) {
      const verbose = out.config as { workspace: string; runtime: string; model: string; mailDir: string };
      console.log(`Workspace: ${verbose.workspace}`);
      console.log(`Runtime: ${verbose.runtime}`);
      console.log(`Model: ${verbose.model}`);
      console.log(`MailDir: ${verbose.mailDir}`);
    }
  }
}

async function decommissionAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent decommission --id <agent-id> [--force]");
    process.exit(1);
  }

  if (!args.force) {
    await confirmDecommission(id);
  }

  const timestamp = Date.now().toString();
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const identityDir = join(homedir(), ".tps", "identity");
  const mailDir = join(homedir(), ".tps", "mail");
  const agentsDir = join(homedir(), ".tps", "agents");

  const keyPath = join(identityDir, `${id}.key`);
  const pubPath = join(identityDir, `${id}.pub`);
  const mailPath = join(mailDir, id);
  const agentConfigPath = join(agentsDir, id);

  const summary: Array<{ label: string; result: string }> = [];

  const flair = createFlairClient(id, flairUrl, keyPath);
  if (existsSync(keyPath)) {
    try {
      (flair as unknown as { loadKey: () => unknown }).loadKey();
    } catch (error) {
      throw new Error(`Failed to load Flair signing key for ${id}: ${String(error)}`);
    }
  }

  const archivedKey = archiveIfExists(keyPath, timestamp);
  summary.push({
    label: "Identity key",
    result: archivedKey ?? "not found",
  });

  const archivedPub = archiveIfExists(pubPath, timestamp);
  summary.push({
    label: "Identity public key",
    result: archivedPub ?? "not found",
  });

  try {
    const agent = await flair.getAgent(id);
    if (agent) {
      await flair.updateAgent(id, { status: "decommissioned" });
      summary.push({ label: "Flair agent", result: `status=decommissioned (${flairUrl})` });
    } else {
      summary.push({ label: "Flair agent", result: "not found" });
    }
  } catch (error) {
    throw new Error(`Failed to archive Flair identity for ${id}: ${String(error)}`);
  }

  const archivedMail = archiveIfExists(mailPath, timestamp);
  summary.push({
    label: "Mail dir",
    result: archivedMail ?? "not found",
  });

  const archivedConfig = archiveIfExists(agentConfigPath, timestamp);
  summary.push({
    label: "Agent config",
    result: archivedConfig ?? "not found",
  });

  console.log(`Decommissioned agent '${id}'.`);
  for (const item of summary) {
    console.log(`  ${item.label}: ${item.result}`);
  }
}

function checkAgentIdentity(agentId: string): AgentHealthcheckResult {
  const configPath = join(healthcheckHomeDir(), ".tps", "agents", agentId, "agent.yaml");
  try {
    readFileSync(configPath, "utf-8");
    return {
      label: "Identity",
      pass: true,
      detail: `~/.tps/agents/${agentId}/agent.yaml`,
    };
  } catch {
    return {
      label: "Identity",
      pass: false,
      detail: `~/.tps/agents/${agentId}/agent.yaml unreadable or missing`,
    };
  }
}

async function checkAgentFlairAuth(agentId: string, flairUrl?: string): Promise<AgentHealthcheckResult> {
  const baseUrl = flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const keyPath = join(healthcheckHomeDir(), ".tps", "identity", `${agentId}.key`);

  try {
    const flair = createFlairClient(agentId, baseUrl, keyPath);
    await flair.search("healthcheck", 1);
    return {
      label: "Flair auth",
      pass: true,
      detail: `authenticated as ${agentId}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label: "Flair auth",
      pass: false,
      detail: message,
    };
  }
}

function checkAgentProcess(agentId: string): AgentHealthcheckResult {
  const pidPath = join(healthcheckHomeDir(), "ops", `tps-${agentId}`, ".tps-agent.pid");

  if (!existsSync(pidPath)) {
    return {
      label: "Process",
      pass: false,
      detail: "no PID file found",
    };
  }

  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (Number.isNaN(pid)) {
      return {
        label: "Process",
        pass: false,
        detail: `invalid PID file: ~/ops/tps-${agentId}/.tps-agent.pid`,
      };
    }
    process.kill(pid, 0);
    return {
      label: "Process",
      pass: true,
      detail: `PID ${pid} running`,
    };
  } catch {
    return {
      label: "Process",
      pass: false,
      detail: `stale PID file: ~/ops/tps-${agentId}/.tps-agent.pid`,
    };
  }
}

function checkAgentMailDir(agentId: string): AgentHealthcheckResult {
  const mailPath = join(healthcheckHomeDir(), ".tps", "mail", agentId, "new");

  if (!existsSync(mailPath)) {
    return {
      label: "Mail dir",
      pass: false,
      detail: `~/.tps/mail/${agentId}/new missing`,
    };
  }

  try {
    accessSync(mailPath, constants.W_OK);
    return {
      label: "Mail dir",
      pass: true,
      detail: `~/.tps/mail/${agentId}/new (writable)`,
    };
  } catch {
    return {
      label: "Mail dir",
      pass: false,
      detail: `~/.tps/mail/${agentId}/new not writable`,
    };
  }
}

export async function healthcheckAgent(args: AgentArgs): Promise<void> {
  const agentId = args.id;
  if (!agentId) {
    console.error("Usage: tps agent healthcheck <agent-id>");
    process.exit(1);
  }

  const checks: AgentHealthcheckResult[] = [
    checkAgentIdentity(agentId),
    await checkAgentFlairAuth(agentId, args.flairUrl),
    checkAgentProcess(agentId),
    checkAgentMailDir(agentId),
  ];

  if (args.json) {
    console.log(JSON.stringify({ agentId, ok: checks.every((check) => check.pass), checks }, null, 2));
  } else {
    for (const check of checks) {
      const prefix = check.pass ? "PASS " : "FAIL ";
      console.log(`${prefix} ${check.label}: ${check.detail}`);
    }
  }

  if (checks.some((check) => !check.pass)) {
    process.exit(1);
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

    case "decommission":
      return decommissionAgent(args);

    case "commit":
      return commitAgentChanges(args);

    case "isolate":
      return isolateAgent(args);

    case "logs":
      return logAgentRuntime(args);

    case "healthcheck":
      return healthcheckAgent(args);

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
        const sandbox = (args as any).sandbox ?? true; // default ON — nono is the required isolation layer
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
                read: [identityDir, bunDir, "/"],
                allow: [mailDir, tmpDir, config.workspace, agentDir],
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

// ─── agent commit ─────────────────────────────────────────────────────────────

const SAFE_GIT_REF_RE = /^[a-zA-Z0-9._/-]+$/;
const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failWith(message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function isWithinDir(root: string, target: string): boolean {
  const rel = require("node:path").relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; status: number } {
  const { spawnSync } = require("node:child_process");
  // Use /usr/bin/git directly to bypass the codex-tools git wrapper
  // (the wrapper blocks commit/push for sandboxed agents, but tps agent commit is the runtime)
  const gitBin = process.env.TPS_GIT_BIN ?? "/usr/bin/git";
  const r = spawnSync(gitBin, args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), status: r.status ?? 1 };
}

function runGitOrFail(args: string[], cwd: string, label: string): string {
  const r = runGit(args, cwd);
  if (!r.ok) failWith(`${label} failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  return r.stdout;
}

async function commitAgentChanges(args: AgentArgs): Promise<void> {
  const { repo, branchName, commitMessage, authorName, authorEmail, paths, push: doPush, prTitle } = args;

  if (!repo || !branchName || !commitMessage || !authorName || !authorEmail) {
    failWith("Usage: tps agent commit --repo <path> --branch <name> --message <msg> --author <name> <email> [--path <file>] [--push] [--pr-title <title>]");
  }
  if (!SIMPLE_EMAIL_RE.test(authorEmail!)) failWith(`Invalid author email: ${authorEmail}`);
  if (branchName!.startsWith("-") || !SAFE_GIT_REF_RE.test(branchName!)) failWith(`Invalid branch name: ${branchName}`);

  const { resolve: resolvePath, relative: relativePath } = require("node:path");
  const { existsSync: exists } = require("node:fs");
  const repoPath = resolvePath(repo!);
  if (!exists(repoPath)) failWith(`Repository path not found: ${repoPath}`);
  if (!repoPath.startsWith("/")) failWith("Repository path must be absolute.");
  const gitCheck = runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
  if (!gitCheck.ok || gitCheck.stdout !== "true") failWith(`Not a git repository: ${repoPath}`);

  // Create or checkout branch
  const branchExists = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath).ok;
  if (branchExists) {
    runGitOrFail(["checkout", branchName!], repoPath, `checkout ${branchName}`);
  } else {
    runGitOrFail(["checkout", "-b", branchName!], repoPath, `create branch ${branchName}`);
  }

  // Stage changes
  if (paths && paths.length > 0) {
    const safePaths = paths.map((p) => {
      const abs = resolvePath(repoPath, p);
      if (!isWithinDir(repoPath, abs)) failWith(`Path escapes repo: ${p}`);
      return relativePath(repoPath, abs) || ".";
    });
    runGitOrFail(["add", "--", ...safePaths], repoPath, "git add");
  } else {
    runGitOrFail(["add", "-A"], repoPath, "git add -A");
  }

  const diff = runGit(["diff", "--cached", "--quiet"], repoPath);
  if (diff.status === 0) {
    // Nothing staged — check if HEAD is already ahead of origin (agent self-committed)
    const ahead = runGit(["rev-list", "--count", `origin/${branchName!}..HEAD`], repoPath);
    const aheadCount = parseInt((ahead.stdout ?? "").trim(), 10);
    if (Number.isNaN(aheadCount) || aheadCount === 0) {
      failWith("No changes staged for commit.");
    }
    // Already committed — skip to push
    console.log(`Changes already committed on ${branchName}. Skipping commit step.`);
  } else {
    runGitOrFail(["commit", "--author", `${authorName} <${authorEmail}>`, "-m", commitMessage!], repoPath, "git commit");
    console.log(`Committed changes in ${repoPath} on branch ${branchName}.`);
  }

  if (!doPush) return;

  runGitOrFail(["push", "-u", "origin", branchName!], repoPath, "git push");
  console.log(`Pushed ${branchName} to origin.`);

  // Open PR via gh-as
  const agentHandle = authorEmail!.split("@")[0] ?? "";
  const title = prTitle ?? commitMessage!;
  const { spawnSync } = require("node:child_process");
  const pr = spawnSync("gh-as", [agentHandle, "pr", "create", "--title", title, "--body", commitMessage!, "--head", branchName!], { cwd: repoPath, encoding: "utf-8" });
  if (pr.status !== 0) {
    const prErr = pr.stderr?.trim() ?? pr.stdout?.trim() ?? "unknown error";
    console.warn(`[tps agent commit] PR creation failed: ${prErr}`);
    console.warn(`[tps agent commit] Branch ${branchName} was pushed — open PR manually with: gh pr create --head ${branchName}`);
    // Exit non-zero so callers (auto-commit) can detect and log the failure
    process.exit(2);
  } else {
    console.log(`PR opened: ${pr.stdout?.trim()}`);
  }
}

// ─── agent isolate ────────────────────────────────────────────────────────────

async function isolateAgent(args: AgentArgs): Promise<void> {
  const id = args.id;
  if (!id) {
    console.error("Usage: tps agent isolate --id <agent-id> [--port <gateway-port>]");
    process.exit(1);
  }

  const ocHome = join(homedir(), `.openclaw-${id}`);
  const srcJson = join(homedir(), ".openclaw", "openclaw.json");
  const dstJson = join(ocHome, "openclaw.json");

  if (!existsSync(srcJson)) {
    console.error(`OpenClaw config not found at ${srcJson}`);
    process.exit(1);
  }

  mkdirSync(ocHome, { recursive: true });

  // Read source config
  const src = JSON.parse(readFileSync(srcJson, "utf-8"));

  // Extract just this agent's entry
  const agentList: any[] = src.agents?.list ?? [];
  const agentEntry = agentList.find((a: any) => a.id === id);
  if (!agentEntry) {
    console.error(`Agent '${id}' not found in OpenClaw config.`);
    process.exit(1);
  }

  // Build isolated config — minimal subset, single agent
  const port = args.port ?? 18800 + Math.floor(Math.random() * 100);
  const isolated = {
    meta: src.meta ?? {},
    wizard: { completed: true },
    secrets: {},
    auth: {},
    models: src.models ?? {},
    agents: {
      defaults: src.agents?.defaults ?? {},
      list: [agentEntry],
    },
    bindings: {},
    messages: {},
    commands: {},
    channels: src.channels ?? {},
    gateway: { port },
    plugins: src.plugins ?? {},
  };

  writeFileSync(dstJson, JSON.stringify(isolated, null, 2), "utf-8");

  console.log(`\nAgent '${id}' isolated at: ${ocHome}`);
  console.log(`Gateway port: ${port}`);
  console.log(`\nTo start the isolated gateway:`);
  console.log(`  OPENCLAW_HOME=${ocHome} openclaw gateway start`);
  console.log(`\nAdd to ~/.tps/agents/${id}/agent.yaml:`);
  console.log(`  openclawHome: ${ocHome}`);
  console.log(`  openclawPort: ${port}`);
}
