#!/usr/bin/env node
import { AgentRuntime } from "./runtime/agent.js";
import { loadAgentConfig } from "./config.js";

function usage(): never {
  console.error("Usage: tps-agent run --config <agent.yaml> --message <text>");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd !== "run") {
    usage();
  }

  const configIdx = args.indexOf("--config");
  const msgIdx = args.indexOf("--message");

  if (configIdx < 0 || msgIdx < 0) {
    usage();
  }

  const configPath = args[configIdx + 1];
  const message = args.slice(msgIdx + 1).join(" ");

  if (!configPath || !message) {
    usage();
  }

  const config = loadAgentConfig(configPath);
  const runtime = new AgentRuntime(config);
  await runtime.runOnce(message);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
