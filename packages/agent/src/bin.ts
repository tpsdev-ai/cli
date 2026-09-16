#!/usr/bin/env node
import { AgentRuntime } from "./runtime/agent.js";
import { loadAgentConfig } from "./config.js";

/** cli#352 r — the launch-id charset/traversal rule, same shape as cli#351 r5's. */
const LAUNCH_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function usage(): never {
  console.error("Usage:");
  console.error("  tps-agent run --config <agent.yaml> --message <text>");
  console.error("  tps-agent start --config <agent.yaml>");
  console.error("  tps-agent health --config <agent.yaml>");
  console.error("  tps-agent check --id <roster-id> --config <agent.yaml>");
  console.error("Options:");
  console.error("  --id <roster-id>  launch id from the supervisor's roster entry (cli#352 r)");
  process.exit(1);
}

function parseArg(name: string, args: string[]): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseConfig(args: string[]): { configPath?: string; command?: string; launchId?: string } {
  const command = args[0];
  const configPath = parseArg("--config", args);
  const launchId = parseArg("--id", args);
  return { command, configPath, launchId };
}

/**
 * cli#352 r — the supervisor's launch path (`nono run … -- tps-agent start`)
 * bypassed the validated-id rule cli#351 r5 put on the CLI path: the agent's
 * writable config could name ANY id, and the runtime would derive its identity
 * key from it. The launch id must come from the supervisor's own roster entry.
 * Mirrors tps agent start's rule exactly: charset + no traversal, and the
 * config must agree (a config that disagrees is tampered or misbuilt).
 */
function validateLaunchId(id: string, source: string): void {
  if (!LAUNCH_ID_RE.test(id) || id.includes("..")) {
    console.error(
      `Invalid agent id (${source}): ${id} — must match ^[a-zA-Z0-9._-]{1,64}$ and contain no traversal`,
    );
    process.exit(1);
  }
}

function assertConfigAgrees(launchId: string, configAgentId: string): void {
  if (configAgentId !== launchId) {
    console.error(
      `❌ agent.yaml agentId '${configAgentId}' does not match the launch id '${launchId}' — refusing to launch (cli#352 r)`,
    );
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { command, configPath, launchId } = parseConfig(args);
  if (!command || command === "--help" || command === "-h") usage();
  if (!configPath) usage();
  if (command === "check" && !launchId) usage();

  if (launchId !== undefined) validateLaunchId(launchId, "--id");

  const config = loadAgentConfig(configPath);

  // cli#352 r — `check` is the supervisor's pre-flight: refuse BEFORE anything
  // is launched, so a refusal cannot leave a partial team running. It is the
  // same rule the launch itself applies below, so the two cannot disagree.
  if (command === "check") {
    if (!launchId) usage();
    assertConfigAgrees(launchId, config.agentId);
    return;
  }

  if (launchId !== undefined) {
    // The runtime derives its identity key from config.agentId; agreeing with
    // the roster id is what makes that derivation safe (cli#352 r).
    assertConfigAgrees(launchId, config.agentId);
    config.agentId = launchId;
  }

  const runtime = new AgentRuntime(config);

  switch (command) {
    case "run": {
      const messageIdx = args.indexOf("--message");
      const message = messageIdx >= 0 ? args.slice(messageIdx + 1).join(" ") : process.env.TPS_AGENT_MESSAGE;
      if (!message) usage();
      await runtime.runOnce(message);
      return;
    }
    case "start": {
      await runtime.start();
      return;
    }
    case "health": {
      const healthy = runtime.isHealthy();
      process.stdout.write(healthy ? "healthy\n" : "unhealthy\n");
      process.exit(healthy ? 0 : 1);
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
