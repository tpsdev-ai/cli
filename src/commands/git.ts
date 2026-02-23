import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { sanitizeIdentifier } from "../schema/sanitizer.js";

export interface GitArgs {
  action: "worktree";
  agent: string;
  repoPath: string; // The base repository to create a worktree from
  branchName?: string; // Optional: branch to checkout or create
}

function branchRoot(): string {
  return join(process.env.HOME || homedir(), ".tps", "branch-office");
}

function workspacePath(agentId: string): string {
  // Simplistic for now, matches common usage. In real usage, 
  // might need to check for team sidecars as in office.ts.
  return join(branchRoot(), agentId, "workspace");
}

export async function runGit(args: GitArgs): Promise<void> {
  const agent = sanitizeIdentifier(args.agent);
  if (!agent || agent !== args.agent) {
    console.error(`Invalid agent identifier: ${args.agent}`);
    process.exit(1);
  }

  const baseRepo = resolve(args.repoPath);
  if (!existsSync(baseRepo)) {
    console.error(`Base repository path not found: ${baseRepo}`);
    process.exit(1);
  }

  // Verify it's a git repo
  const gitCheck = spawnSync("git", ["-C", baseRepo, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (gitCheck.status !== 0) {
    console.error(`Path is not a git repository: ${baseRepo}`);
    process.exit(1);
  }

  const repoName = basename(baseRepo);
  const targetDir = join(workspacePath(agent), repoName);

  if (existsSync(targetDir)) {
    console.error(`Worktree target directory already exists: ${targetDir}`);
    process.exit(1);
  }

  // Ensure workspace exists
  mkdirSync(workspacePath(agent), { recursive: true });

  console.log(`Creating git worktree for ${agent} at ${targetDir}...`);

  const gitArgs = ["worktree", "add", targetDir];
  if (args.branchName) {
    gitArgs.push(args.branchName);
  }

  const result = spawnSync("git", ["-C", baseRepo, ...gitArgs], {
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.status !== 0) {
    console.error("Failed to create git worktree.");
    process.exit(result.status ?? 1);
  }

  console.log(`✓ Git worktree created successfully for ${agent}.`);
}
