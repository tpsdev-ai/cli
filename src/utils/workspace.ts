import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Get the root directory where branch-office workspaces are stored.
 */
export function branchRoot(): string {
  return join(process.env.HOME || homedir(), ".tps", "branch-office");
}

/**
 * Resolve the workspace path for an agent, accounting for team sidecars.
 */
export function workspacePath(agentId: string): string {
  const teamPath = join(branchRoot(), agentId);
  const teamSidecar = join(teamPath, "team.json");
  if (existsSync(teamSidecar)) {
    return join(teamPath, "workspace");
  }

  try {
    const teams = readdirSync(branchRoot()).filter(d => {
      return existsSync(join(branchRoot(), d, "team.json"));
    });

    for (const team of teams) {
      const sidecarPath = join(branchRoot(), team, "team.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      if (Array.isArray(sidecar.members) && sidecar.members.includes(agentId)) {
        return join(branchRoot(), team, "workspace");
      }
    }
  } catch {
    // Fallback
  }

  return join(branchRoot(), agentId);
}
