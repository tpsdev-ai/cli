import { spawn } from "node:child_process";
import { resolveConfigPath, readOpenClawConfig, getAgentList, resolveWorkspace } from "../utils/config.js";
import { randomQuip } from "../utils/output.js";
import { existsSync } from "node:fs";

interface OfficeProps {
  agentName: string;
  configPath?: string;
}

export function runOffice(args: OfficeProps) {
  let configPath: string | null;
  try {
    configPath = resolveConfigPath(args.configPath);
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  if (!configPath) {
    console.error(`❌ No openclaw.json found. ${randomQuip("error")}`);
    process.exit(1);
  }

  const config = readOpenClawConfig(configPath);
  const agents = getAgentList(config);
  
  // Find agent
  const agent = agents.find(
    (a) =>
      (a.id?.toLowerCase() === args.agentName.toLowerCase()) ||
      (a.name?.toLowerCase() === args.agentName.toLowerCase())
  );

  if (!agent) {
    console.error(`❌ Agent "${args.agentName}" not found in roster.`);
    console.error(`   (Use 'tps roster' to see available agents)`);
    process.exit(1);
  }

  const workspace = resolveWorkspace(agent, config);
  
  if (!workspace || !existsSync(workspace)) {
    console.error(`❌ Agent "${agent.name || agent.id}" has no workspace at ${workspace || "(unknown)"}.`);
    process.exit(1);
  }

  // Use consistent sandbox naming: tps-office-<agent-id>
  const sandboxName = `tps-office-${agent.id}`;
  
  console.log(`🏢 Opening office for ${agent.name || agent.id}...`);
  console.log(`   Workspace: ${workspace}`);
  console.log(`   Sandbox:   ${sandboxName}`);
  console.log(`   Command:   docker sandbox run --name ${sandboxName} claude ${workspace}`);
  console.log("");
  
  const child = spawn("docker", ["sandbox", "run", "--name", sandboxName, "claude", workspace], {
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code || 0);
  });
  
  child.on("error", (err) => {
    console.error(`❌ Failed to start docker sandbox: ${err.message}`);
    process.exit(1);
  });
}
