import { dirname, isAbsolute, resolve } from "node:path";
import { WorktreeLifecycleError } from "./agent-lifecycle.js";

export function agentWorkspace(
  configPath: string,
  configuredWorkspace: string,
  childEnv?: NodeJS.ProcessEnv,
): string {
  // Relative workspaces use the config pathname's directory.
  const workspace = childEnv?.TPS_AGENT_WORKSPACE ?? resolve(dirname(configPath), configuredWorkspace);
  const pending = childEnv?.TPS_WORKTREE_PENDING;
  if (!isAbsolute(workspace) || (pending !== undefined && (!isAbsolute(pending) || pending !== workspace))) {
    throw new WorktreeLifecycleError("pending worktree workspace mismatch");
  }
  return workspace;
}
