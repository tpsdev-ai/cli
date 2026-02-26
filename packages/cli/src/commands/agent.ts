import { AgentRuntime, loadAgentConfig } from "@tpsdev-ai/agent";

export interface AgentArgs {
  action: "run";
  config: string;
  message?: string;
}

export async function runAgent(args: AgentArgs): Promise<void> {
  if (args.action !== "run") {
    console.error("Usage: tps agent run --config <agent.yaml> --message <text>");
    process.exit(1);
  }

  if (!args.message) {
    const message = process.env.TPS_AGENT_MESSAGE;
    if (!message) {
      console.error("Usage: tps agent run --config <agent.yaml> --message <text>");
      process.exit(1);
    }
    args.message = message;
  }

  const config = loadAgentConfig(args.config);
  const runtime = new AgentRuntime(config);
  await runtime.runOnce(args.message);
}
