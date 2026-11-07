import { dirname, isAbsolute, resolve } from "node:path";
import { refuseTildeWorkspace } from "@tpsdev-ai/agent";
import { WorktreeLifecycleError } from "./agent-lifecycle.js";

export function agentWorkspace(
  configPath: string,
  configuredWorkspace: string,
  childEnv?: NodeJS.ProcessEnv,
): string {
  refuseTildeWorkspace(configuredWorkspace);
  // Relative workspaces use the config pathname's directory.
  const workspace = childEnv?.TPS_AGENT_WORKSPACE ?? resolve(dirname(configPath), configuredWorkspace);
  const pending = childEnv?.TPS_WORKTREE_PENDING;
  if (!isAbsolute(workspace) || (pending !== undefined && (!isAbsolute(pending) || pending !== workspace))) {
    throw new WorktreeLifecycleError("pending worktree workspace mismatch");
  }
  return workspace;
}

/**
 * Resolve `autoCommit.repo` the way a relative `workspace` is resolved: against
 * the config file's directory, so the runtime only ever sees an absolute path.
 * A relative value with no config file to anchor it is refused rather than
 * resolved against the process working directory.
 */
export function resolveAutoCommitRepo(configured: string | undefined, configPath?: string): string | undefined {
  if (configured === undefined) return undefined;
  refuseTildeWorkspace(configured, "autoCommit.repo");
  if (isAbsolute(configured)) return resolve(configured);
  if (configPath === undefined) {
    throw new Error(
      `autoCommit.repo '${configured}' is relative and there is no config file path to resolve it against: use an absolute path`,
    );
  }
  return resolve(dirname(configPath), configured);
}
