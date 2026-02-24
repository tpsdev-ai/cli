import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeIdentifier } from "../schema/sanitizer.js";

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
  const safeId = sanitizeIdentifier(agentId);
  const root = branchRoot();

  const teamPath = join(root, safeId);
  const teamSidecar = join(teamPath, "team.json");
  if (existsSync(teamSidecar)) {
    return safeId; // The provided ID is already a team
  }

  try {
    const teams = readdirSync(root).filter((d) => {
      return existsSync(join(root, d, "team.json"));
    });

    for (const team of teams) {
      const sidecarPath = join(root, team, "team.json");
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      // Note: team.json uses 'members' for agent IDs
      if (Array.isArray(sidecar.members) && sidecar.members.includes(safeId)) {
        return team; // Agent is a member of this team
      }
    }
  } catch {
    // Fallback
  }

  return safeId; // Standalone agent
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
