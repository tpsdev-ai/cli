import { describe, expect, mock, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { resolveAutoCommitRepo } from "../src/utils/agent-workspace.ts";
import {
  composeSystemPrompt,
  detectStaleRebase,
  evaluateMailAutoCommitGate,
  hasWorkspaceChangesOrNewCommit,
  probeHead,
  publishTaskOutcomeEvent,
  resolveCommitRepo,
  runAutoCommit,
  syncWorkspaceBeforeTask,
  type CodexRuntimeConfig,
} from "../src/utils/codex-runtime.ts";

afterEach(() => {
  mock.restore();
});

const config: CodexRuntimeConfig = {
  agentId: "ember",
  workspace: "/tmp/repo",
  mailDir: "/tmp/mail",
};

describe("composeSystemPrompt", () => {
  test("appends config systemPrompt before past experience", () => {
    const result = composeSystemPrompt(
      "Flair soul",
      "Agent YAML instructions",
      "Past experience",
    );

    expect(result).toBe("Flair soul\n\nAgent YAML instructions\n\nPast experience");
  });
});

describe("hasWorkspaceChangesOrNewCommit", () => {
  test("detects a new HEAD commit even when the working tree is clean", () => {
    expect(hasWorkspaceChangesOrNewCommit("", "abc123", "def456")).toBe(true);
    expect(hasWorkspaceChangesOrNewCommit("", "abc123", "abc123")).toBe(false);
    expect(hasWorkspaceChangesOrNewCommit(" M file.ts", "abc123", "abc123")).toBe(true);
  });
});

const GIT = process.env.TPS_GIT_BIN ?? "/usr/bin/git";

/** Run git in `cwd` and throw on a non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(GIT, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "");
}

/** A repository with one commit on `main`, at `dir`. */
function initRepoAt(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "agent-a@example.com");
  git(dir, "config", "user.name", "agent-a");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-q", "-m", "base");
}

/** A repository with one commit on `main`, in a fresh temp dir. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli800-gate-"));
  initRepoAt(dir);
  return dir;
}

/** An executable `git` stand-in in `dir`; the caller supplies its shell body. */
function gitShim(dir: string, body: string): string {
  const path = join(dir, "git");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Run the shim with the args and cwd the runtime passed. */
function shimRunner(shim: string, env?: Record<string, string>): typeof spawnSync {
  return ((_cmd: string, args: string[], opts: { cwd?: string }) =>
    spawnSync(shim, args, { cwd: opts.cwd, encoding: "utf-8", env: { ...process.env, ...env } })) as unknown as typeof spawnSync;
}

/** Commit a conflicting change on `topic` and on `main`, then return to `topic`. */
function conflictingBranches(cwd: string): void {
  git(cwd, "checkout", "-q", "-b", "topic");
  writeFileSync(join(cwd, "file.txt"), "topic\n");
  git(cwd, "commit", "-q", "-am", "topic");
  git(cwd, "checkout", "-q", "main");
  writeFileSync(join(cwd, "file.txt"), "main\n");
  git(cwd, "commit", "-q", "-am", "main");
  git(cwd, "checkout", "-q", "topic");
}

/** Start a conflicting rebase and leave it interrupted; returns the mid-rebase HEAD. */
function interruptedRebase(cwd: string): string {
  conflictingBranches(cwd);
  expect(spawnSync(GIT, ["rebase", "main"], { cwd, encoding: "utf-8" }).status).not.toBe(0);
  return git(cwd, "rev-parse", "HEAD").trim();
}

describe("detectStaleRebase", () => {
  test("reports a stale rebase in a main checkout", () => {
    const repo = initRepo();
    try {
      interruptedRebase(repo);
      expect(detectStaleRebase(repo)).toEqual({ state: "present" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports a stale rebase in a linked worktree whose .git file is relative", () => {
    const repo = initRepo();
    const worktree = `${repo}-wt`;
    try {
      git(repo, "worktree", "add", "-q", "-b", "topic", worktree, "main");
      writeFileSync(join(worktree, "file.txt"), "topic\n");
      git(worktree, "commit", "-q", "-am", "topic");
      writeFileSync(join(repo, "file.txt"), "main\n");
      git(repo, "commit", "-q", "-am", "main");
      // git writes an absolute gitdir; rewrite it relative to the worktree, which
      // git resolves against the .git file's directory.
      const gitFile = join(worktree, ".git");
      const gitDir = readFileSync(gitFile, "utf-8").trim().replace(/^gitdir:\s*/, "");
      const relativeGitDir = relative(worktree, gitDir);
      expect(isAbsolute(relativeGitDir)).toBe(false);
      writeFileSync(gitFile, `gitdir: ${relativeGitDir}\n`);
      expect(spawnSync(GIT, ["rev-parse", "--git-path", "rebase-merge"], { cwd: worktree, encoding: "utf-8" }).status).toBe(0);

      expect(spawnSync(GIT, ["rebase", "main"], { cwd: worktree, encoding: "utf-8" }).status).not.toBe(0);
      expect(detectStaleRebase(worktree)).toEqual({ state: "present" });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports a stale rebase started with the apply backend", () => {
    const repo = initRepo();
    try {
      conflictingBranches(repo);
      expect(spawnSync(GIT, ["rebase", "--apply", "main"], { cwd: repo, encoding: "utf-8" }).status).not.toBe(0);
      expect(detectStaleRebase(repo)).toEqual({ state: "present" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports no stale rebase in a clean repository", () => {
    const repo = initRepo();
    try {
      expect(detectStaleRebase(repo)).toEqual({ state: "absent" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports indeterminate when the directory is not a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-norepo-"));
    try {
      expect(detectStaleRebase(dir)).toEqual({
        state: "indeterminate",
        probe: "git rev-parse --path-format=absolute --git-path rebase-merge",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports indeterminate when the probe output is not an absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-oldgit-"));
    try {
      const shim = gitShim(dir, 'echo "--path-format=absolute"');
      expect(detectStaleRebase(dir, shimRunner(shim))).toEqual({
        state: "indeterminate",
        probe: "git rev-parse --path-format=absolute --git-path rebase-merge",
        output: "--path-format=absolute",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("evaluateMailAutoCommitGate", () => {
  test("chooses commit when the repository has an uncommitted change", () => {
    const repo = initRepo();
    try {
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "file.txt"), "changed\n");
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({ action: "commit" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("chooses commit when the task created a new commit", () => {
    const repo = initRepo();
    try {
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "file.txt"), "committed\n");
      git(repo, "commit", "-q", "-am", "task");
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({ action: "commit" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports the pre-task comparison when nothing changed", () => {
    const repo = initRepo();
    try {
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "clean",
        message: "Git status is clean and HEAD matches its pre-task value — skipping autoCommit",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("task commits made before an interrupted rebase are kept, so the gate commits", () => {
    const repo = initRepo();
    try {
      // The runtime reads the baseline before the task runs.
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "-b", "topic");
      writeFileSync(join(repo, "file.txt"), "task\n");
      git(repo, "commit", "-q", "-am", "task");
      const taskCommit = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "file.txt"), "main\n");
      git(repo, "commit", "-q", "-am", "main");
      git(repo, "checkout", "-q", "topic");
      expect(spawnSync(GIT, ["rebase", "main"], { cwd: repo, encoding: "utf-8" }).status).not.toBe(0);

      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({ action: "commit" });

      // The abort restored the tip that contains the task's commit, and it is
      // still reachable from the branch after the gate ran.
      expect(git(repo, "branch", "--show-current").trim()).toBe("topic");
      expect(
        spawnSync(GIT, ["merge-base", "--is-ancestor", taskCommit, "HEAD"], { cwd: repo, encoding: "utf-8" }).status,
      ).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("aborting an interrupted rebase with no task commits stays clean against the pre-task baseline", () => {
    const repo = initRepo();
    try {
      // A branch tip above `main` that predates the task, and the pre-task HEAD
      // read the runtime makes before the task runs.
      git(repo, "checkout", "-q", "-b", "topic");
      writeFileSync(join(repo, "file.txt"), "topic\n");
      git(repo, "commit", "-q", "-am", "before task");
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "file.txt"), "main\n");
      git(repo, "commit", "-q", "-am", "main");
      git(repo, "checkout", "-q", "topic");
      expect(spawnSync(GIT, ["rebase", "main"], { cwd: repo, encoding: "utf-8" }).status).not.toBe(0);

      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "clean",
        message: "Git status is clean and HEAD matches its pre-task value — skipping autoCommit",
      });
      const rebasePath = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge").trim();
      expect(existsSync(rebasePath)).toBe(false);
      expect(git(repo, "status", "--porcelain").trim()).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("skips as indeterminate when HEAD changes between the restored and final reads", () => {
    const repo = initRepo();
    try {
      // A branch tip above `main` that predates the task; the pre-task HEAD is
      // that tip, and the abort restores it.
      git(repo, "checkout", "-q", "-b", "topic");
      writeFileSync(join(repo, "file.txt"), "topic\n");
      git(repo, "commit", "-q", "-am", "before task");
      const baseline = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "file.txt"), "main\n");
      git(repo, "commit", "-q", "-am", "main");
      git(repo, "checkout", "-q", "topic");
      expect(spawnSync(GIT, ["rebase", "main"], { cwd: repo, encoding: "utf-8" }).status).not.toBe(0);

      // The first post-abort read is the real restored HEAD; HEAD then moves
      // before the final read, so the gate must skip and name both values.
      let restored = "";
      let moved = "";
      let headReads = 0;
      const runSync = ((command: any, args: any, options: any) => {
        if ((args as string[]).join(" ") === "rev-parse --verify -q HEAD^{commit}") {
          headReads++;
          if (headReads === 1) {
            const read = spawnSync(command, args, options);
            restored = String(read.stdout ?? "").trim();
            return read;
          }
          writeFileSync(join(repo, "moved.txt"), "moved\n");
          git(repo, "add", "moved.txt");
          git(repo, "commit", "-q", "-m", "moved");
          moved = git(repo, "rev-parse", "HEAD").trim();
          return { status: 0, stdout: `${moved}\n`, stderr: "" };
        }
        return spawnSync(command, args, options);
      }) as typeof spawnSync;

      expect(evaluateMailAutoCommitGate(repo, baseline, { runSync })).toEqual({
        action: "skip",
        message: `Change check could not run: HEAD changed between the restored read and the final read (restored ${restored}, final ${moved}) — skipping autoCommit`,
      });
      // The fixture followed a real abort, and HEAD really moved after it.
      expect(restored).toBe(baseline);
      expect(moved).not.toBe(restored);
      expect(headReads).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("skips and reports when the stale-rebase probe cannot run", () => {
    const runSync = (() => ({ status: 128, stdout: "", stderr: "fixture probe failure" })) as unknown as typeof spawnSync;
    expect(evaluateMailAutoCommitGate("/tmp/not-a-repo", "abc123", { runSync })).toEqual({
      action: "skip",
      message: "Stale rebase check could not run: git rev-parse --path-format=absolute --git-path rebase-merge failed — skipping autoCommit",
    });
  });

  test("skips naming the probe and its non-absolute output", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-oldgit-gate-"));
    try {
      const shim = gitShim(dir, 'echo "--path-format=absolute"');
      expect(evaluateMailAutoCommitGate(dir, "abc123", { runSync: shimRunner(shim) })).toEqual({
        action: "skip",
        message:
          "Stale rebase check could not run: git rev-parse --path-format=absolute --git-path rebase-merge returned '--path-format=absolute' — skipping autoCommit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("skips when the final HEAD read has no output", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli800-empty-head-"));
    try {
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "${SHIM_ROOT}/rebase-merge"; exit 0; fi',
          'if [ "$1" = "symbolic-ref" ]; then echo "refs/heads/main"; exit 0; fi',
          'if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then exit 0; fi',
          'if [ "$1" = "status" ]; then exit 0; fi',
          'exit 0',
        ].join("\n"),
      );
      const runSync = shimRunner(shim, { SHIM_ROOT: dir });
      expect(probeHead(dir, runSync)).toEqual({
        state: "indeterminate",
        detail: "returned no output",
        probe: "git rev-parse --verify -q HEAD^{commit}",
      });
      expect(evaluateMailAutoCommitGate(dir, "abc123", { runSync })).toEqual({
        action: "skip",
        message: "Change check could not run: git rev-parse --verify -q HEAD^{commit} (after task) returned no output — skipping autoCommit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("names HEAD^{commit} when its successful probe has empty output", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli835-empty-commit-probe-"));
    try {
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "$SHIM_ROOT/rebase-merge"; exit 0; fi',
          'if [ "$1" = "symbolic-ref" ]; then echo "refs/heads/main"; exit 0; fi',
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then exit 0; fi',
          'if [ "$1" = "status" ]; then exit 0; fi',
          'exit 128',
        ].join("\n"),
      );
      const runSync = shimRunner(shim, { SHIM_ROOT: dir });
      expect(probeHead(dir, runSync)).toEqual({
        state: "indeterminate",
        detail: "returned no output",
        probe: "git rev-parse --verify -q HEAD^{commit}",
      });
      expect(evaluateMailAutoCommitGate(dir, "abc123", { runSync })).toEqual({
        action: "skip",
        message: "Change check could not run: git rev-parse --verify -q HEAD^{commit} (after task) returned no output — skipping autoCommit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("evaluateMailAutoCommitGate unborn HEAD", () => {
  /** A fresh repository with an unborn `main` HEAD. */
  function initUnbornRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "cli835-unborn-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "agent-a@example.com");
    git(dir, "config", "user.name", "agent-a");
    return dir;
  }

  test("selects the commit path when HEAD is unborn and the task leaves a change", () => {
    const repo = initUnbornRepo();
    try {
      const baseline = probeHead(repo);
      writeFileSync(join(repo, "file.txt"), "first\n");
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({ action: "commit" });
      expect(baseline).toEqual({ state: "unborn" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unborn HEAD with no changes is clean", () => {
    const repo = initUnbornRepo();
    try {
      const baseline = probeHead(repo);
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "clean",
        message: "Git status is clean and HEAD is unborn — skipping autoCommit",
      });
      expect(baseline).toEqual({ state: "unborn" });
      const head = spawnSync(GIT, ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
      expect(head.status).toBe(1);
      expect(String(head.stdout ?? "").trim()).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a clean orphan branch beside a committed branch reports an unborn HEAD", () => {
    const repo = initRepo();
    try {
      git(repo, "checkout", "-q", "--orphan", "empty");
      git(repo, "rm", "-q", "-f", "file.txt");
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(git(repo, "log", "-1", "--format=%H", "main").trim()).not.toBe("");
      const baseline = probeHead(repo);
      expect(baseline).toEqual({ state: "unborn" });
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "clean",
        message: "Git status is clean and HEAD is unborn — skipping autoCommit",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a corrupted HEAD is an indeterminate skip naming the probe", () => {
    const repo = initUnbornRepo();
    try {
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/bad..name\n");
      const baseline = probeHead(repo);
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "skip",
        message: "Change check could not run: git symbolic-ref -q HEAD (before task) failed — skipping autoCommit",
      });
      expect(baseline).toEqual({ state: "indeterminate", detail: "failed", probe: "git symbolic-ref -q HEAD" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a symbolic HEAD outside refs/heads/ is indeterminate", () => {
    const repo = initUnbornRepo();
    try {
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/tags/x\n");
      expect(probeHead(repo)).toEqual({ state: "indeterminate", detail: "returned a ref outside refs/heads/", probe: "git symbolic-ref -q HEAD" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a symbolic HEAD that points at an existing tag on a commit is indeterminate and skips at the gate", () => {
    const repo = initRepo();
    try {
      git(repo, "tag", "v1");
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/tags/v1\n");
      const baseline = probeHead(repo);
      expect(baseline).toEqual({ state: "indeterminate", detail: "returned a ref outside refs/heads/", probe: "git symbolic-ref -q HEAD" });
      expect(evaluateMailAutoCommitGate(repo, baseline)).toEqual({
        action: "skip",
        message: "Change check could not run: git symbolic-ref -q HEAD (before task) returned a ref outside refs/heads/ — skipping autoCommit",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a detached HEAD at a commit is a commit baseline", () => {
    const repo = initRepo();
    try {
      const sha = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "--detach", sha);
      expect(probeHead(repo)).toEqual({ state: "commit", head: sha });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a symbolic-ref error with a resolvable commit is indeterminate and skips naming the probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli835-symbolic-"));
    try {
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "symbolic-ref" ]; then exit 128; fi',
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "${SHIM_ROOT}/rebase-merge"; exit 0; fi',
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then echo "$SHIM_HEAD"; exit 0; fi',
          'exit 0',
        ].join("\n"),
      );
      const runSync = shimRunner(shim, { SHIM_ROOT: dir, SHIM_HEAD: "a".repeat(40) });
      const baseline = probeHead(dir, runSync);
      expect(baseline).toEqual({ state: "indeterminate", detail: "failed", probe: "git symbolic-ref -q HEAD" });
      expect(evaluateMailAutoCommitGate(dir, baseline, { runSync })).toEqual({
        action: "skip",
        message: "Change check could not run: git symbolic-ref -q HEAD (before task) failed — skipping autoCommit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("symbolic-ref exit 1 with stderr is indeterminate and skips naming the probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli835-symbolic-stderr-"));
    try {
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "$SHIM_ROOT/rebase-merge"; exit 0; fi',
          'if [ "$1" = "symbolic-ref" ]; then echo "fatal: probe failed" >&2; exit 1; fi',
          'if [ "$1" = "rev-parse" ]; then echo "$SHIM_HEAD"; exit 0; fi',
          'exit 0',
        ].join("\n"),
      );
      const runSync = shimRunner(shim, { SHIM_ROOT: dir, SHIM_HEAD: "a".repeat(40) });
      const baseline = probeHead(dir, runSync);
      expect(baseline).toEqual({ state: "indeterminate", detail: "failed", probe: "git symbolic-ref -q HEAD" });
      expect(evaluateMailAutoCommitGate(dir, baseline, { runSync })).toEqual({
        action: "skip",
        message: "Change check could not run: git symbolic-ref -q HEAD (before task) failed — skipping autoCommit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a symbolic-ref failure after rebase abort names the failed probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli835-post-abort-symbolic-"));
    try {
      mkdirSync(join(dir, "rebase-merge"));
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "$SHIM_ROOT/rebase-merge"; exit 0; fi',
          'if [ "$1" = "rebase" ] && [ "$2" = "--abort" ]; then touch "$SHIM_ROOT/aborted"; exit 0; fi',
          'if [ "$1" = "symbolic-ref" ]; then if [ -f "$SHIM_ROOT/aborted" ]; then echo "fatal: probe failed" >&2; exit 128; fi; echo "refs/heads/main"; exit 0; fi',
          'if [ "$1" = "rev-parse" ]; then echo "$SHIM_HEAD"; exit 0; fi',
          'exit 0',
        ].join("\n"),
      );
      const runSync = shimRunner(shim, { SHIM_ROOT: dir, SHIM_HEAD: "a".repeat(40) });
      const baseline = probeHead(dir, runSync);
      expect(baseline).toEqual({ state: "commit", head: "a".repeat(40) });
      expect(evaluateMailAutoCommitGate(dir, baseline, { runSync })).toEqual({
        action: "skip",
        message: "Change check could not run: git symbolic-ref -q HEAD (after rebase abort) failed — skipping autoCommit",
      });
      expect(existsSync(join(dir, "aborted"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("missing-ref probes with exit 1 and stderr are indeterminate and skip naming the probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli835-missing-stderr-"));
    try {
      const shim = gitShim(
        dir,
        [
          'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then echo "$SHIM_ROOT/rebase-merge"; exit 0; fi',
          'if [ "$1" = "symbolic-ref" ]; then echo "refs/heads/main"; exit 0; fi',
          'if [ "$*" = "$SHIM_FAIL_ARGS" ]; then echo "fatal: probe failed" >&2; exit 1; fi',
          'if [ "$1" = "rev-parse" ] || [ "$1" = "show-ref" ]; then exit 1; fi',
          'exit 0',
        ].join("\n"),
      );
      for (const args of [
        "rev-parse --verify -q HEAD^{commit}",
        "rev-parse --verify -q HEAD",
        "show-ref --verify -q refs/heads/main",
      ]) {
        const runSync = shimRunner(shim, { SHIM_ROOT: dir, SHIM_FAIL_ARGS: args });
        const probe = `git ${args}`;
        const baseline = probeHead(dir, runSync);
        expect(baseline).toEqual({ state: "indeterminate", detail: "failed", probe });
        expect(evaluateMailAutoCommitGate(dir, baseline, { runSync })).toEqual({
          action: "skip",
          message: `Change check could not run: ${probe} (before task) failed — skipping autoCommit`,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("skips naming the restored and final HEADs when an aborted rebase leaves an unborn final HEAD", () => {
    const repo = initUnbornRepo();
    try {
      const baseline = probeHead(repo);
      expect(baseline).toEqual({ state: "unborn" });
      // The task commits on `topic`, branches a conflicting commit on `other`,
      // and starts a rebase it leaves interrupted.
      git(repo, "checkout", "-q", "-b", "topic");
      writeFileSync(join(repo, "file.txt"), "task\n");
      git(repo, "add", "file.txt");
      git(repo, "commit", "-q", "-m", "task");
      git(repo, "checkout", "-q", "-b", "other");
      writeFileSync(join(repo, "file.txt"), "other\n");
      git(repo, "commit", "-q", "-am", "other");
      git(repo, "checkout", "-q", "topic");
      writeFileSync(join(repo, "file.txt"), "task follow-up\n");
      git(repo, "commit", "-q", "-am", "follow-up");
      const restored = git(repo, "rev-parse", "HEAD").trim();
      expect(spawnSync(GIT, ["rebase", "other"], { cwd: repo, encoding: "utf-8" }).status).not.toBe(0);

      // The abort restores `topic` at the task's tip; deleting that ref before
      // the final read makes HEAD unborn again.
      let deleted = false;
      const runSync = ((command: any, args: any, options: any) => {
        if (!deleted && (args as string[]).join(" ") === "status --porcelain") {
          deleted = true;
          const drop = spawnSync(GIT, ["update-ref", "-d", "refs/heads/topic"], { cwd: repo, encoding: "utf-8" });
          if (drop.status !== 0) throw new Error(String(drop.stderr));
        }
        return spawnSync(command, args, options);
      }) as typeof spawnSync;

      expect(evaluateMailAutoCommitGate(repo, baseline, { runSync })).toEqual({
        action: "skip",
        message: `Change check could not run: HEAD changed between the restored read and the final read (restored ${restored}, final unborn) — skipping autoCommit`,
      });
      expect(deleted).toBe(true);
      expect(probeHead(repo)).toEqual({ state: "unborn" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("resolveAutoCommitRepo", () => {
  test("a relative autoCommit.repo in a real config file resolves against the config file's directory from a different cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "cli800-config-"));
    try {
      const configDir = join(root, "config");
      const repoDir = join(configDir, "repo");
      const launchDir = join(root, "launch");
      mkdirSync(configDir);
      mkdirSync(launchDir);
      initRepoAt(repoDir);
      const configFile = join(configDir, "agent.yaml");
      writeFileSync(configFile, "agentId: agent-a\nworkspace: workspace\nautoCommit:\n  repo: repo\n");

      // The child parses the real config file with js-yaml from a third
      // directory and resolves autoCommit.repo against the config file's
      // directory, then runs the gate and the commit there.
      const workspaceSource = resolve(import.meta.dir, "../src/utils/agent-workspace.ts");
      const runtimeSource = resolve(import.meta.dir, "../src/utils/codex-runtime.ts");
      const yamlModule = resolve(import.meta.dir, "../../../node_modules/js-yaml/index.js");
      const script = join(launchDir, "probe.ts");
      writeFileSync(script, `
        import { readFileSync, writeFileSync } from "node:fs";
        import { spawnSync } from "node:child_process";
        import { join } from "node:path";
        import yaml from ${JSON.stringify(yamlModule)};
        import { resolveAutoCommitRepo } from ${JSON.stringify(workspaceSource)};
        import { evaluateMailAutoCommitGate } from ${JSON.stringify(runtimeSource)};
        const configPath = ${JSON.stringify(configFile)};
        const parsed = yaml.load(readFileSync(configPath, "utf-8"));
        const repo = resolveAutoCommitRepo(parsed.autoCommit.repo, configPath);
        const probe = spawnSync("${GIT}", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { encoding: "utf-8" });
        const result = { repo, cwd: process.cwd(), git: probe.status, decision: null, add: null, commit: null, stderr: "" };
        if (probe.status === 0 && probe.stdout.trim() === "true") {
          const baseline = String(spawnSync("${GIT}", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).stdout ?? "").trim();
          writeFileSync(join(repo, "task.txt"), "task\\n");
          result.decision = evaluateMailAutoCommitGate(repo, baseline);
          result.add = spawnSync("${GIT}", ["-C", repo, "add", "task.txt"], { encoding: "utf-8" }).status;
          const committed = spawnSync("${GIT}", ["-C", repo, "commit", "-m", "task"], { encoding: "utf-8" });
          result.commit = committed.status;
          result.stderr = committed.stderr;
        }
        console.log(JSON.stringify(result));
      `);
      const child = spawnSync(process.execPath, [script], { cwd: launchDir, encoding: "utf-8", timeout: 30_000 });
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout.trim());
      expect(result.git).toBe(0);
      expect(result.cwd).toBe(launchDir);
      expect(result.repo).toBe(repoDir);
      expect(isAbsolute(result.repo)).toBe(true);
      expect(result.decision).toEqual({ action: "commit" });
      expect(result.add).toBe(0);
      expect(result.commit).toBe(0);
      expect(git(repoDir, "log", "--format=%s").split("\n")).toContain("task");
      expect(existsSync(join(launchDir, ".git"))).toBe(false);
      expect(existsSync(join(launchDir, "repo"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("refuses an empty or blank autoCommit.repo after environment expansion", () => {
    const configPath = join(tmpdir(), "cli800-empty-repo", "agent.yaml");
    expect(() => resolveAutoCommitRepo("", configPath)).toThrow(
      "autoCommit.repo is empty or blank: omit it to use the workspace, or give a path",
    );
    expect(() => resolveAutoCommitRepo("   ", configPath, true)).toThrow(
      "autoCommit.repo is empty or blank: omit it to use the workspace, or give a path",
    );
    const previous = process.env.EMPTY;
    process.env.EMPTY = "";
    try {
      expect(() => resolveAutoCommitRepo("${EMPTY}", configPath, true)).toThrow(
        "autoCommit.repo is empty or blank: omit it to use the workspace, or give a path",
      );
    } finally {
      if (previous === undefined) delete process.env.EMPTY;
      else process.env.EMPTY = previous;
    }
  });

  test("an empty YAML repo entry is absent, so the workspace fallback applies", () => {
    const parsed = yaml.load("autoCommit:\n  repo:\n") as { autoCommit: { repo: unknown } };
    expect(parsed.autoCommit.repo).toBeNull();
    expect(resolveAutoCommitRepo(parsed.autoCommit.repo as string | null, join(tmpdir(), "agent.yaml"))).toBeUndefined();
    expect(
      resolveCommitRepo({ workspace: "/tmp/workspace", autoCommit: { repo: parsed.autoCommit.repo as string | undefined } }),
    ).toBe("/tmp/workspace");
  });

  test("refuses a relative autoCommit.repo when no config path can anchor it", () => {
    expect(() => resolveAutoCommitRepo("repo")).toThrow(
      "autoCommit.repo 'repo' is relative and there is no config file path to resolve it against: use an absolute path",
    );
  });

  test("the runtime refuses a relative autoCommit.repo", () => {
    expect(() => resolveCommitRepo({ workspace: "/tmp/workspace", autoCommit: { repo: "repo" } })).toThrow(
      "autoCommit.repo 'repo' is relative: use an absolute path",
    );
  });
});

describe("runAutoCommit", () => {
  test("creates the branch before invoking tps agent commit when HEAD is detached", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let tpsEnv: NodeJS.ProcessEnv | undefined;
    const savedAgentId = process.env.TPS_AGENT_ID;
    process.env.TPS_AGENT_ID = "parent-agent";
    const spawnSyncImpl = mock((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "checkout -b feat/task-123") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M file.ts\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-parse --verify refs/remotes/origin/feat/task-123") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-list --count HEAD") {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      if (cmd === "tps") {
        tpsEnv = opts?.env;
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    try {
      await runAutoCommit(
        config,
        { publishEvent: mock(async () => {}) },
        {
          taskId: "task-123",
          branchName: "feat/task-123",
          commitMessage: "feat: ship task 123",
          authorName: "ember",
          authorEmail: "ember@tps.dev",
          push: true,
          prTitle: "feat: ship task 123",
        },
        { spawnSyncImpl },
      );

      // The commit child gets the configured id; the runtime's own environment is
      // unchanged.
      expect(tpsEnv?.TPS_AGENT_ID).toBe("ember");
      expect(process.env.TPS_AGENT_ID).toBe("parent-agent");
    } finally {
      if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
      else process.env.TPS_AGENT_ID = savedAgentId;
    }

    expect(calls).toEqual([
      { cmd: "/usr/bin/git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "/usr/bin/git", args: ["checkout", "-b", "feat/task-123"] },
      { cmd: "/usr/bin/git", args: ["status", "--porcelain"] },
      { cmd: "/usr/bin/git", args: ["rev-parse", "--verify", "refs/remotes/origin/feat/task-123"] },
      { cmd: "/usr/bin/git", args: ["rev-list", "--count", "HEAD"] },
      {
        cmd: "tps",
        args: [
          "agent",
          "commit",
          "--repo",
          "/tmp/repo",
          "--branch",
          "feat/task-123",
          "--message",
          "feat: ship task 123",
          "--author",
          "ember",
          "ember@tps.dev",
          "--push",
          "--pr-title",
          "feat: ship task 123",
        ],
      },
    ]);
  });

  test("opens a PR via gh-as when push, openPr, and prRepo are configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-456\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M file.ts\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-parse --verify refs/remotes/origin/feat/task-456") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-list --count HEAD") {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh-as") {
        return { status: 0, stdout: "https://github.com/tpsdev-ai/cli/pull/123\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const prUrl = await runAutoCommit(
      config,
      { publishEvent: mock(async () => {}) },
      {
        taskId: "task-456",
        branchName: "feat/task-456",
        commitMessage: "feat: ship task 456",
        authorName: "Ember",
        authorEmail: "ember@tps.dev",
        push: true,
        openPr: true,
        prRepo: "tpsdev-ai/cli",
        ghAgent: "ember",
        prTitle: "feat: ship task 456",
      },
      { spawnSyncImpl },
    );

    // The runtime attempts bounded pr.opened publication with this URL; only an
    // accepted POST can reach the review loop. Exhausted retries call console.warn
    // and return without an event if no POST was accepted.
    expect(prUrl).toBe("https://github.com/tpsdev-ai/cli/pull/123");

    expect(calls).toEqual([
      { cmd: "/usr/bin/git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "/usr/bin/git", args: ["status", "--porcelain"] },
      { cmd: "/usr/bin/git", args: ["rev-parse", "--verify", "refs/remotes/origin/feat/task-456"] },
      { cmd: "/usr/bin/git", args: ["rev-list", "--count", "HEAD"] },
      {
        cmd: "tps",
        args: [
          "agent",
          "commit",
          "--repo",
          "/tmp/repo",
          "--branch",
          "feat/task-456",
          "--message",
          "feat: ship task 456",
          "--author",
          "Ember",
          "ember@tps.dev",
          "--push",
        ],
      },
      {
        cmd: "gh-as",
        args: [
          "ember",
          "pr",
          "create",
          "--repo",
          "tpsdev-ai/cli",
          "--head",
          "feat/task-456",
          "--title",
          "feat: ship task 456",
          "--body",
          "feat: ship task 456",
        ],
      },
    ]);
  });

  test("pushes existing commits and opens a PR when Codex already committed", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-789\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-parse --verify refs/remotes/origin/feat/task-789") {
        return { status: 0, stdout: "originref\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-list --count origin/feat/task-789..HEAD") {
        return { status: 0, stdout: "1\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "checkout -b feat/task-789") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "push -u origin feat/task-789") {
        return { status: 0, stdout: "pushed\n", stderr: "" };
      }
      if (cmd === "gh-as") {
        return { status: 0, stdout: "https://github.com/tpsdev-ai/cli/pull/789\n", stderr: "" };
      }
      if (cmd === "tps") {
        throw new Error("tps agent commit should not run when reusing existing commits");
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await runAutoCommit(
      config,
      { publishEvent: mock(async () => {}) },
      {
        taskId: "task-789",
        branchName: "feat/task-789",
        commitMessage: "feat: ship task 789",
        authorName: "Ember",
        authorEmail: "ember@tps.dev",
        push: true,
        openPr: true,
        prRepo: "tpsdev-ai/cli",
        ghAgent: "ember",
        prTitle: "feat: ship task 789",
      },
      { spawnSyncImpl },
    );

    expect(calls).toEqual([
      { cmd: "/usr/bin/git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "/usr/bin/git", args: ["status", "--porcelain"] },
      { cmd: "/usr/bin/git", args: ["rev-parse", "--verify", "refs/remotes/origin/feat/task-789"] },
      { cmd: "/usr/bin/git", args: ["rev-list", "--count", "origin/feat/task-789..HEAD"] },
      { cmd: "/usr/bin/git", args: ["checkout", "-b", "feat/task-789"] },
      { cmd: "/usr/bin/git", args: ["push", "-u", "origin", "feat/task-789"] },
      {
        cmd: "gh-as",
        args: [
          "ember",
          "pr",
          "create",
          "--repo",
          "tpsdev-ai/cli",
          "--head",
          "feat/task-789",
          "--title",
          "feat: ship task 789",
          "--body",
          "feat: ship task 789",
        ],
      },
    ]);
  });

  test("returns no PR URL when no PR is opened", async () => {
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-1\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M file.ts\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-parse --verify refs/remotes/origin/feat/task-1") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-list --count HEAD") {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const prUrl = await runAutoCommit(
      config,
      { publishEvent: mock(async () => {}) },
      {
        taskId: "task-1",
        branchName: "feat/task-1",
        commitMessage: "feat: ship task 1",
        authorName: "ember",
        authorEmail: "ember@tps.dev",
        push: true,
      },
      { spawnSyncImpl },
    );

    expect(prUrl).toBeUndefined();
  });

  test("publishes a blocker OrgEvent when runtime PR creation fails", async () => {
    const publishEvent = mock(async () => {});
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-456\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M file.ts\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-parse --verify refs/remotes/origin/feat/task-456") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "rev-list --count HEAD") {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh-as") {
        expect(args).toEqual([
          "ember",
          "pr",
          "create",
          "--repo",
          "tpsdev-ai/cli",
          "--head",
          "feat/task-456",
          "--title",
          "feat: ship task 456",
          "--body",
          "feat: ship task 456",
        ]);
        return { status: 1, stdout: "", stderr: "gh-as pr create failed" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await expect(runAutoCommit(
      config,
      { publishEvent },
      {
        taskId: "task-456",
        branchName: "feat/task-456",
        commitMessage: "feat: ship task 456",
        authorName: "ember",
        authorEmail: "ember@tps.dev",
        push: true,
        openPr: true,
        prRepo: "tpsdev-ai/cli",
        ghAgent: "ember",
        prTitle: "feat: ship task 456",
      },
      { spawnSyncImpl },
    )).rejects.toThrow("gh-as pr create failed: gh-as pr create failed");

    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledWith({
      kind: "blocker",
      summary: "PR creation failed for task-456",
      detail: "gh-as pr create failed",
      refId: "task-456",
    });
  });
});

describe("publishTaskOutcomeEvent", () => {
  test("publishes task.completed OrgEvents with the runtime payload", async () => {
    const request = mock(async () => ({}));

    await publishTaskOutcomeEvent(
      { request },
      "ember",
      {
        kind: "task.completed",
        summary: "Task task-123 completed by ember",
        refId: "task-123",
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/OrgEvent", {
      kind: "task.completed",
      summary: "Task task-123 completed by ember",
      refId: "task-123",
      authorId: "ember",
    });
  });

  test("publishes task.failed OrgEvents with the runtime payload", async () => {
    const request = mock(async () => ({}));

    await publishTaskOutcomeEvent(
      { request },
      "ember",
      {
        kind: "task.failed",
        summary: "Task task-123 failed: boom",
        refId: "task-123",
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/OrgEvent", {
      kind: "task.failed",
      summary: "Task task-123 failed: boom",
      refId: "task-123",
      authorId: "ember",
    });
  });
});

describe("syncWorkspaceBeforeTask", () => {
  test("hard-resets to origin/branch when origin HEAD is available", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // All git commands succeed by default
      return { status: 0, stdout: "", stderr: "" };
    });

    // Override symbolic-ref to return trunk
    const origImpl = spawnSyncImpl.mock.calls;
    const impl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/trunk\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl: impl });

    // Must include: rebase --abort, checkout, fetch, reset --hard, clean -fd
    expect(calls.some(c => c.args.join(" ") === "rebase --abort")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "checkout trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "fetch origin trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "reset --hard origin/trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "clean -fd")).toBe(true);
  });

  test("falls back to main when origin HEAD is not configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl });

    expect(calls.some(c => c.args.join(" ") === "checkout main")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "reset --hard origin/main")).toBe(true);
  });

  test("warns and continues when reset fails", async () => {
    const warn = mock(() => {});
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "reset --hard origin/main") {
        return { status: 1, stdout: "", stderr: "fatal: cannot reset" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl, warn });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("git reset --hard failed"),
    );
  });
});
