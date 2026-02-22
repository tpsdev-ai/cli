/**
 * Agent info enrichment — reads workspace files and mail stats
 * to provide richer context for roster show and review commands.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getInbox } from "./mail.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";

export interface AgentProfile {
  role?: string;
  creature?: string;
  emoji?: string;
  vibe?: string;
}

export interface MailStats {
  unread: number;
  read: number;
  total: number;
}

export interface MemoryInfo {
  fileCount: number;
  latestFile?: string;
  latestDate?: string;
}

export interface AgentInfo {
  profile: AgentProfile;
  mail: MailStats;
  memory: MemoryInfo;
  workspaceFileCount: number;
  workspaceSize: number;
}

/**
 * Parse key-value frontmatter from IDENTITY.md or SOUL.md.
 * Looks for lines like "**Name:** Flint" or "- **Role:** Strategy"
 */
function extractField(content: string, field: string): string | undefined {
  // Match "**Field:** value" pattern
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const match = content.match(re);
  return match?.[1]?.trim();
}

export function readProfile(workspacePath: string): AgentProfile {
  const profile: AgentProfile = {};

  const identityPath = join(workspacePath, "IDENTITY.md");
  if (existsSync(identityPath)) {
    try {
      const content = readFileSync(identityPath, "utf-8");
      profile.creature = extractField(content, "Creature");
      profile.emoji = extractField(content, "Emoji");
      profile.vibe = extractField(content, "Vibe");
    } catch { /* ignore */ }
  }

  const soulPath = join(workspacePath, "SOUL.md");
  if (existsSync(soulPath)) {
    try {
      const content = readFileSync(soulPath, "utf-8");
      profile.role = extractField(content, "Role");
    } catch { /* ignore */ }
  }

  return profile;
}

export function getMailStats(agentId: string): MailStats {
  const safe = sanitizeIdentifier(agentId);
  if (safe !== agentId) return { unread: 0, read: 0, total: 0 };

  try {
    const inbox = getInbox(agentId);
    const unread = existsSync(inbox.fresh)
      ? readdirSync(inbox.fresh).filter((f) => f.endsWith(".json")).length
      : 0;
    const read = existsSync(inbox.cur)
      ? readdirSync(inbox.cur).filter((f) => f.endsWith(".json")).length
      : 0;
    return { unread, read, total: unread + read };
  } catch {
    return { unread: 0, read: 0, total: 0 };
  }
}

export function getMemoryInfo(workspacePath: string): MemoryInfo {
  const memoryDir = join(workspacePath, "memory");
  if (!existsSync(memoryDir)) return { fileCount: 0 };

  try {
    const files = readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();

    return {
      fileCount: files.length,
      latestFile: files[0],
      latestDate: files[0]?.replace(".md", ""),
    };
  } catch {
    return { fileCount: 0 };
  }
}

export function getAgentInfo(agentId: string, workspacePath?: string): AgentInfo {
  const profile = workspacePath ? readProfile(workspacePath) : {};
  const mail = getMailStats(agentId);
  const memory = workspacePath ? getMemoryInfo(workspacePath) : { fileCount: 0 };

  let workspaceFileCount = 0;
  let workspaceSize = 0;
  if (workspacePath && existsSync(workspacePath)) {
    try {
      const entries = readdirSync(workspacePath);
      for (const e of entries) {
        try {
          const s = statSync(join(workspacePath, e));
          if (s.isFile()) {
            workspaceFileCount++;
            workspaceSize += s.size;
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return { profile, mail, memory, workspaceFileCount, workspaceSize };
}
