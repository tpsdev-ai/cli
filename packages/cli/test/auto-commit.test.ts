import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import * as os from "node:os";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const TMP_ROOT = resolve(import.meta.dir, "../.tmp-tests");

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init"], repo);
  git(["checkout", "-b", "main"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["config", "user.email", "test@tps.dev"], repo);
  writeFileSync(join(repo, "README.md"), "init\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);
  return repo;
}

mkdirSync(TMP_ROOT, { recursive: true });

describe("ops-68: auto-commit lifecycle", () => {
  test("commits on a task branch with correct author", () => {
    const tmp = mkdtempSync(join(TMP_ROOT, "auto-commit-"));
    try {
      const repo = initRepo(tmp);
      writeFileSync(join(repo, "output.ts"), "export const x = 1;\n");
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
      const result = spawnSync("bun", [TPS_BIN, "agent", "commit",
        "--repo", repo, "--branch", "task/ops-68",
        "--message", "task complete: ops-68",
        "--author", "Ember", "ember@tps.dev",
      ], { encoding: "utf-8", env: cleanEnv });
      expect(result.status).toBe(0);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("task/ops-68");
      expect(git(["log", "-1", "--format=%an <%ae>|%s"], repo)).toBe("Ember <ember@tps.dev>|task complete: ops-68");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("noops gracefully when no changes staged", () => {
    const tmp = mkdtempSync(join(TMP_ROOT, "auto-commit-"));
    try {
      const repo = initRepo(tmp);
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
      const result = spawnSync("bun", [TPS_BIN, "agent", "commit",
        "--repo", repo, "--branch", "task/no-changes",
        "--message", "task complete: empty",
        "--author", "Ember", "ember@tps.dev",
      ], { encoding: "utf-8", env: cleanEnv });
      expect(result.status).not.toBe(0); // should fail with "No changes staged"
      expect((result.stderr ?? "") + (result.stdout ?? "")).toContain("No changes staged");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
