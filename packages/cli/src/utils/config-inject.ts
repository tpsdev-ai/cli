/**
 * Safe config injection for openclaw.json.
 * 
 * Pattern: read → backup → verify backup → modify → write
 * If backup verification fails, abort. No exceptions.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

export interface InjectAgentEntry {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: unknown;
  heartbeat?: unknown;
  [key: string]: unknown;
}

export interface InjectResult {
  success: boolean;
  backupPath: string;
  agentId: string;
  error?: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Inject an agent entry into openclaw.json's agents.list array.
 * 
 * Safety guarantees:
 * 1. Reads original file and computes hash
 * 2. Writes backup to <path>.bak
 * 3. Reads backup back and verifies hash matches original
 * 4. Only then modifies and writes the config
 * 5. If agent ID already exists, aborts (no duplicates)
 */
export function injectAgent(configPath: string, agent: InjectAgentEntry): InjectResult {
  const backupPath = configPath + ".bak";

  // Step 1: Read original
  if (!existsSync(configPath)) {
    return { success: false, backupPath, agentId: agent.id, error: `Config not found: ${configPath}` };
  }

  const original = readFileSync(configPath, "utf-8");
  const originalHash = sha256(original);

  // Step 2: Parse and validate structure
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(original);
  } catch {
    return { success: false, backupPath, agentId: agent.id, error: "Config is not valid JSON" };
  }

  if (!config.agents || typeof config.agents !== "object") {
    return { success: false, backupPath, agentId: agent.id, error: "Config missing agents section" };
  }

  const agents = config.agents as Record<string, unknown>;
  if (!Array.isArray(agents.list)) {
    agents.list = [];
  }

  const list = agents.list as InjectAgentEntry[];

  // Step 3: Check for duplicates
  if (list.some((a) => a.id === agent.id)) {
    return { success: false, backupPath, agentId: agent.id, error: `Agent "${agent.id}" already exists in config` };
  }

  // Step 4: Write backup
  copyFileSync(configPath, backupPath);

  // Step 5: Verify backup matches original (the critical step)
  const backupContent = readFileSync(backupPath, "utf-8");
  const backupHash = sha256(backupContent);

  if (backupHash !== originalHash) {
    return {
      success: false,
      backupPath,
      agentId: agent.id,
      error: `Backup verification failed! Original hash ${originalHash} !== backup hash ${backupHash}. Aborting — config NOT modified.`,
    };
  }

  // Step 6: Inject and write
  list.push(agent);
  const updated = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(configPath, updated, "utf-8");

  // Step 7: Verify write is valid JSON
  try {
    JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Restore from backup immediately
    copyFileSync(backupPath, configPath);
    return {
      success: false,
      backupPath,
      agentId: agent.id,
      error: "Written config was invalid JSON — restored from backup.",
    };
  }

  return { success: true, backupPath, agentId: agent.id };
}
