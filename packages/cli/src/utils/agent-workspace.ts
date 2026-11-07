import { dirname, isAbsolute, resolve } from "node:path";
import { interpolateEnvInString, refuseTildeWorkspace } from "@tpsdev-ai/agent";
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
 * the config file's directory. With `expandEnv`, a loader that reads the config
 * itself expands `${NAME}` before resolving; a relative value passed to the
 * runtime directly is refused by `resolveCommitRepo`. A relative value with no
 * config file to anchor it is refused rather than resolved against the process
 * working directory.
 */
export function resolveAutoCommitRepo(
  configured: string | undefined,
  configPath?: string,
  expandEnv = false,
): string | undefined {
  if (configured === undefined) return undefined;
  const value = expandEnv ? interpolateEnvInString(configured) : configured;
  refuseTildeWorkspace(value, "autoCommit.repo");
  if (isAbsolute(value)) return resolve(value);
  if (configPath === undefined) {
    throw new Error(
      `autoCommit.repo '${value}' is relative and there is no config file path to resolve it against: use an absolute path`,
    );
  }
  return resolve(dirname(configPath), value);
}
