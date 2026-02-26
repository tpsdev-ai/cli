#!/usr/bin/env node
import { AgentRuntime } from "./runtime/agent.js";
import { loadAgentConfig } from "./config.js";

function usage(): never {
  console.error("Usage:");
  console.error("  tps-agent run --config <agent.yaml> --message <text>");
  console.error("  tps-agent start --config <agent.yaml>");
  console.error("  tps-agent health --config <agent.yaml>");
  process.exit(1);
}

function parseArg(name: string, args: string[]): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseConfig(args: string[]): { configPath?: string; command?: string } {
  const command = args[0];
  const configPath = parseArg("--config", args);
  return { command, configPath };
}

async function main() {
  const args = process.argv.slice(2);
  const { command, configPath } = parseConfig(args);
  if (!command || command === "--help" || command === "-h") usage();
  if (!configPath) usage();

  const config = loadAgentConfig(configPath);
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
