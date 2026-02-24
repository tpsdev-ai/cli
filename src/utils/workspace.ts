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
 * Resolves the logical team ID for an agent. If the agent is part of a team,
 * returns the team's ID. If standalone, returns the agent's ID.
 */
export function resolveTeamId(agentId: string): string {
  const teamPath = join(branchRoot(), agentId);
  const teamSidecar = join(teamPath, "team.json");
  if (existsSync(teamSidecar)) {
    return agentId; // The provided ID is already a team
  }

  try {
    const teams = readdirSync(branchRoot()).filter((d) => {
      return existsSync(join(branchRoot(), d, "team.json"));
    });

    for (const team of teams) {
      const sidecarPath = join(branchRoot(), team, "team.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      if (Array.isArray(sidecar.members) && sidecar.members.includes(agentId)) {
        return team; // Agent is a member of this team
      }
    }
  } catch {
    // Fallback
  }

  return agentId; // Standalone agent
}

/**
 * Resolve the workspace path for an agent, accounting for team sidecars.
 */
export function workspacePath(agentId: string): string {
  const teamId = resolveTeamId(agentId);
  const teamPath = join(branchRoot(), teamId);

  // If it's a team directory, the actual workspace is in /workspace
  if (existsSync(join(teamPath, "team.json"))) {
    return join(teamPath, "workspace");
  }

  return teamPath;
}
