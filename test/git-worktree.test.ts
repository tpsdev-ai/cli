import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TPS_BIN = join(import.meta.dir, "../dist/bin/tps.js");

describe("tps git worktree", () => {
  let tempDir: string;
  let repoPath: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tps-git-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.HOME = tempDir;
    process.env.TPS_VAULT_KEY = "test-passphrase";

    // Setup dummy repo
    repoPath = join(tempDir, "dummy-repo");
    mkdirSync(repoPath, { recursive: true });
    spawnSync("git", ["init"], { cwd: repoPath });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Dummy Repo");
    spawnSync("git", ["add", "README.md"], { cwd: repoPath });
    spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates a worktree in the agent workspace", () => {
    const result = spawnSync("bun", [TPS_BIN, "git", "worktree", "testbot", repoPath], {
      encoding: "utf8",
      env: { ...process.env }
    });

    if (result.status !== 0) {
      console.error(result.stderr);
    }
    expect(result.status).toBe(0);

    const targetDir = join(tempDir, ".tps", "branch-office", "testbot", "workspace", "dummy-repo");
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, ".git"))).toBe(true);
    
    // Verify it's actually a worktree
    const gitCheck = spawnSync("git", ["-C", targetDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    expect(gitCheck.stdout.trim()).toBe("true");
  });

  test("rejects if not a git repository", () => {
    const notARepo = join(tempDir, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });

    const result = spawnSync("bun", [TPS_BIN, "git", "worktree", "testbot", notARepo], {
      encoding: "utf8",
      env: { ...process.env }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Path is not a git repository");
  });
});
