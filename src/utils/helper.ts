import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Interface for a TPS mail message
 */
interface TpsMailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read: boolean;
}

/**
 * Finds the most recent task mail in the agent's mail cur directory
 * @returns The most recent mail message or null if none found
 */
export function findMostRecentTaskMail(agentId: string = "anvil"): TpsMailMessage | null {
  const home = homedir();
  const mailDir = join(home, ".tps", "mail", agentId, "cur");
  
  if (!existsSync(mailDir)) {
    return null;
  }

  try {
    const files = readdirSync(mailDir)
      .filter(file => file.endsWith(".json"))
      .map(file => ({
        file,
        path: join(mailDir, file),
        mtime: statSync(join(mailDir, file)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length === 0) {
      return null;
    }

    const latestFile = files[0];
    const content = require("fs").readFileSync(latestFile.path, "utf8");
    return JSON.parse(content) as TpsMailMessage;
  } catch (error) {
    console.error(`Error reading mail: ${error}`);
    return null;
  }
}

/**
 * Extracts file path hints from a mail body using multiple heuristics
 * @param mailBody The body text of the mail message
 * @returns Array of unique file paths mentioned in the mail
 */
export function extractFilePathHints(mailBody: string): string[] {
  if (!mailBody) return [];

  const hints = new Set<string>();

  // Heuristic 1: Backtick-wrapped paths (`src/main.ts`, `packages/cli/bin/tps.ts`)
  const backtickMatches = mailBody.match(/`[^`]+`/g) || [];
  for (const match of backtickMatches) {
    const trimmed = match.slice(1, -1); // Remove backticks
    const filePath = extractTsJsPath(trimmed);
    if (filePath) hints.add(filePath);
  }

  // Heuristic 2: Inline paths like ~/agents/anvil/bin, ~/.tps/mail/anvil/cur
  const inlineMatches = mailBody.match(/(?:~(?:\/|$|\/))|\/(?:[^\s\"'<>\[\]{}|\\^%&*+=;:,.]+(?:\/[^\s\"'<>\[\]{}|\\^%&*+=;:,.]+)*)/g) || [];
  for (const match of inlineMatches) {
    const filePath = extractTsJsPath(match);
    if (filePath) hints.add(filePath);
  }

  // Heuristic 3: Loose file mentions like "scripts/foo.sh" without backticks
  const looseMatches = mailBody.match(/\b[a-zA-Z0-9_\/.-]+\/(?:[a-zA-Z0-9_\/.-]+\.)?(?:ts|js|sh|mjs|cjs|json|yml|yaml|md|toml|env)\b/g) || [];
  for (const match of looseMatches) {
    const filePath = extractTsJsPath(match);
    if (filePath) hints.add(filePath);
  }

  return Array.from(hints);
}

/**
 * Extracts a TypeScript/JavaScript file path from a string, returning null if not found
 * @param input String that may contain a file path
 * @returns File path if it looks like a TS/JS file, otherwise null
 */
function extractTsJsPath(input: string): string | null {
  if (!input) return null;
  
  // Look for paths ending with common file extensions
  const match = input.match(/([^\s\"'<>\[\]{}|\\^%&*+=;:,.]+\.(?:ts|js|sh|mjs|cjs|json|yml|yaml|md|toml|env))/);
  if (match) {
    return match[1];
  }
  
  return null;
}

/**
 * Gets the working-tree diff file count (staged + unstaged changes)
 * @returns Number of files changed in the working tree
 */
export function getWorkingTreeDiffCount(repoPath: string = "."): number {
  try {
    // Get unstaged changes
    const diffResult = spawnSync("git", ["diff", "--name-only"], { 
      cwd: repoPath, 
      encoding: "utf8" 
    });
    
    // Get staged changes
    const cachedResult = spawnSync("git", ["diff", "--cached", "--name-only"], { 
      cwd: repoPath, 
      encoding: "utf8" 
    });
    
    let allFiles = "";
    
    if (diffResult.status === 0 && diffResult.stdout) {
      allFiles += diffResult.stdout;
    }
    
    if (cachedResult.status === 0 && cachedResult.stdout) {
      allFiles += cachedResult.stdout;
    }
    
    // Split by newline, filter out empty lines, and get unique files
    const files = allFiles
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .filter((value, index, self) => self.indexOf(value) === index);
    
    return files.length;
  } catch (error) {
    console.error(`Error getting diff count: ${error}`);
    return 0;
  }
}

/**
 * Gets the lines of code changes in the working tree
 * @returns Number of lines changed (insertions + deletions)
 */
export function getWorkingTreeDiffLoc(repoPath: string = "."): number {
  try {
    const result = spawnSync("git", ["diff", "--stat"], { 
      cwd: repoPath, 
      encoding: "utf8" 
    });
    
    if (result.status !== 0 || !result.stdout) {
      return 0;
    }
    
    // Parse output like " 5 files changed, 32 insertions(+), 12 deletions(-)"
    const match = result.stdout.match(/(\d+)\s+insertions?\+/);
    const insertions = match ? parseInt(match[1], 10) : 0;
    
    const match2 = result.stdout.match(/(\d+)\s+deletions?-/);
    const deletions = match2 ? parseInt(match2[1], 10) : 0;
    
    return insertions + deletions;
  } catch (error) {
    console.error(`Error getting diff LOC: ${error}`);
    return 0;
  }
}

/**
 * Checks if scope expansion has occurred based on mail hints and working tree diff
 * @param agentId The agent ID to check mail for
 * @param thresholdMultiplier The multiplier for the threshold (default: 3)
 * @returns Object with check results
 */
export function checkScopeExpansion(
  agentId: string = "anvil", 
  thresholdMultiplier: number = 3
): {
  withinThreshold: boolean;
  hintCount: number;
  diffCount: number;
  diffLoc: number;
  threshold: number;
  warningMessage?: string;
} {
  const mail = findMostRecentTaskMail(agentId);
  let hintCount = 0;
  
  if (mail && mail.body) {
    const hints = extractFilePathHints(mail.body);
    hintCount = hints.length;
  }
  
  const diffCount = getWorkingTreeDiffCount();
  const diffLoc = getWorkingTreeDiffLoc();
  
  const threshold = hintCount * thresholdMultiplier;
  const withinThreshold = diffCount <= threshold;
  
  let warningMessage: string | undefined;
  
  if (!withinThreshold && hintCount > 0) {
    warningMessage = `SCOPE EXPANSION DETECTED — original task hinted at ${hintCount} files; diff touches ${diffCount} files (${diffLoc} LOC). Continue with --ack-scope-expansion or revise.`;
  }
  
  return {
    withinThreshold,
    hintCount,
    diffCount,
    diffLoc,
    threshold,
    warningMessage
  };
}