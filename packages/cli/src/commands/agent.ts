import { AgentRuntime, loadAgentConfig } from "@tpsdev-ai/agent";

export interface AgentArgs {
  action: "run" | "start" | "health";
  config: string;
  message?: string;
}

export async function runAgent(args: AgentArgs): Promise<void> {
  const config = loadAgentConfig(args.config);
  const runtime = new AgentRuntime(config);

  if (args.action === "run") {
    const message = args.message || process.env.TPS_AGENT_MESSAGE;
    if (!message) {
      console.error("Usage: tps agent run --config <agent.yaml> --message <text>");
      process.exit(1);
    }
    await runtime.runOnce(message);
    return;
  }

  if (args.action === "start") {
    await runtime.start();
    return;
  }

  if (args.action === "health") {
    const healthy = runtime.isHealthy();
    process.stdout.write(healthy ? "healthy\n" : "unhealthy\n");
    process.exit(healthy ? 0 : 1);
  }
}
