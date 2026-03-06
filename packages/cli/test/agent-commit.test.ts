import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const TMP_ROOT = resolve(import.meta.dir, "../.tmp-tests");

function runCommand(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  runCommand("git", ["init"], repo);
  runCommand("git", ["checkout", "-b", "main"], repo);
  runCommand("git", ["config", "user.name", "Test User"], repo);
  runCommand("git", ["config", "user.email", "test@example.com"], repo);
  writeFileSync(join(repo, "tracked.txt"), "base tracked\n");
  writeFileSync(join(repo, "other.txt"), "base other\n");
  runCommand("git", ["add", "-A"], repo);
  runCommand("git", ["commit", "-m", "initial"], repo);
  return repo;
}

mkdirSync(TMP_ROOT, { recursive: true });

describe("tps agent commit", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("creates a branch and commits only the requested paths", () => {
    const root = mkdtempSync(join(TMP_ROOT, "agent-commit-"));
    tempRoots.push(root);
    const repo = initRepo(root);

    writeFileSync(join(repo, "tracked.txt"), "changed tracked\n");
    writeFileSync(join(repo, "other.txt"), "changed other\n");

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))
    );
    const result = spawnSync("bun", [
      TPS_BIN,
      "agent",
      "commit",
      "--repo", repo,
      "--branch", "feat/path-scope",
      "--message", "path scoped commit",
      "--author", "Ember", "ember@tps.dev",
      "--path", "tracked.txt",
    ], {
      cwd: repo,
      encoding: "utf-8",
      env: cleanEnv,
    });

    expect(result.status).toBe(0);
    expect(runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("feat/path-scope");
    expect(runCommand("git", ["log", "-1", "--format=%an <%ae>|%s"], repo)).toBe("Ember <ember@tps.dev>|path scoped commit");
    expect(runCommand("git", ["show", "--name-only", "--pretty=format:", "HEAD"], repo)).toBe("tracked.txt");
    expect(runCommand("git", ["status", "--short"], repo)).toContain("M other.txt");
  });

  test("pushes the branch and opens a PR via gh-as", () => {
    const root = mkdtempSync(join(TMP_ROOT, "agent-commit-"));
    tempRoots.push(root);
    const repo = initRepo(root);
    const remote = join(root, "remote.git");
    const binDir = join(root, "bin");
    const ghLog = join(root, "gh-as.log");

    runCommand("git", ["init", "--bare", remote], root);
    runCommand("git", ["remote", "add", "origin", remote], repo);
    runCommand("git", ["push", "-u", "origin", "main"], repo);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "gh-as"),
      `#!/bin/sh
printf '%s\n' "$@" > "${ghLog}"
`,
    );
    chmodSync(join(binDir, "gh-as"), 0o755);

    writeFileSync(join(repo, "tracked.txt"), "push me\n");

    const result = spawnSync("bun", [
      TPS_BIN,
      "agent",
      "commit",
      "--repo", repo,
      "--branch", "feat/push-pr",
      "--message", "ship push flow",
      "--author", "Ember", "ember@tps.dev",
      "--push",
      "--pr-title", "feat: push flow",
    ], {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(runCommand("git", ["--git-dir", remote, "rev-parse", "refs/heads/feat/push-pr"], root)).not.toHaveLength(0);
    expect(readFileSync(ghLog, "utf-8").trim()).toBe(
      [
        "ember",
        "pr",
        "create",
        "--title",
        "feat: push flow",
        "--body",
        "ship push flow",
        "--head",
        "feat/push-pr",
      ].join("\n"),
    );
  });
});
