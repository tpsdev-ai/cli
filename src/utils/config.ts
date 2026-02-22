import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface OpenClawAgent {
  id: string;
  name?: string;
  model?: string | Record<string, unknown>;
  thinking?: string;
  workspace?: string;
  agentDir?: string;
  channel?: string;
  [key: string]: unknown;
}

export interface OpenClawConfig {
  agents?: {
    defaults?: Record<string, unknown>;
    list?: OpenClawAgent[];
  };
  [key: string]: unknown;
}

export function getAgentList(config: OpenClawConfig): OpenClawAgent[] {
  return config.agents?.list || [];
}

export function getDefaults(config: OpenClawConfig): Record<string, unknown> {
  return config.agents?.defaults || {};
}

/**
 * Resolve an agent's workspace, falling back to agents.defaults.workspace.
 */
export function resolveWorkspace(agent: OpenClawAgent, config: OpenClawConfig): string | undefined {
  if (agent.workspace) return agent.workspace;
  const defaults = getDefaults(config);
  return defaults.workspace as string | undefined;
}

export function findOpenClawConfig(startDir?: string): string | null {
  let dir = startDir || process.cwd();
  const home = process.env.HOME || "/";

  while (true) {
    const candidate = join(dir, "openclaw.json");
    if (existsSync(candidate)) return candidate;
    const dotCandidate = join(dir, ".openclaw", "openclaw.json");
    if (existsSync(dotCandidate)) return dotCandidate;

    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }

  // Last resort: ~/.openclaw/openclaw.json
  const globalConfig = join(home, ".openclaw", "openclaw.json");
  if (existsSync(globalConfig)) return globalConfig;

  return null;
}

export function readOpenClawConfig(configPath: string): OpenClawConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as OpenClawConfig;
}

/**
 * Resolve config path: use explicit path if given, otherwise auto-discover.
 */
export function resolveConfigPath(explicit?: string): string | null {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Config file not found: ${explicit}`);
    }
    return explicit;
  }
  return findOpenClawConfig();
}
