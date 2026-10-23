/**
 * cli#660 — a launch that adds a worktree and then fails before the parent
 * records the setup binding must remove the worktree it added.
 *
 * The failure cases inject a metadata error after a real `git worktree add` (a
 * `git` wrapper that fails `rev-parse --absolute-git-dir`, which setup runs
 * first after the add).
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  onStart,
  removeCreatedWorktree,
  WorktreeLifecycleError,
  type WorktreeCreation,
} from "../src/utils/agent-lifecycle.js";

const GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

interface Fixture {
  root: string;
  base: string;
  workspace: string;
}

/** A base repository at <root>/tps and a workspace at <root>/ws, nothing else. */
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-cleanup-660-")));
  const base = join(root, "tps");
  mkdirSync(base);
  const git = (args: string[]) => {
    const result = spawnSync(GIT, args, { cwd: base, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
  return { root, base, workspace: join(root, "ws") };
}

function branches(base: string): string[] {
  const listed = spawnSync(GIT, ["branch", "--format=%(refname:short)"], { cwd: base, encoding: "utf8" });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split("\n").filter(Boolean).sort();
}

function worktreeList(base: string): string {
  const listed = spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: base, encoding: "utf8" });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout;
}

/**
 * A git wrapper that fails the first metadata step after the add. `beforeFail`
 * runs before the injected failure, and `failRemoval` makes the cleanup's
 * `worktree remove` fail too.
 */
function installWrapper(f: Fixture, opts: { beforeFail?: string; failRemoval?: boolean } = {}): { bin: string; restore: () => void } {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then',
      ...(opts.beforeFail ? [opts.beforeFail.split("\n").map((line) => `  ${line}`).join("\n")] : []),
      '  echo "injected metadata failure" >&2',
      "  exit 79",
      "fi",
      ...(opts.failRemoval
        ? [
            'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
            '  echo "fatal: cannot remove a locked working tree" >&2',
            "  exit 1",
            "fi",
          ]
        : []),
      `exec "${GIT}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return { bin, restore: () => { process.env.PATH = oldPath; } };
}

test("a failure after the worktree add removes the worktree it created", () => {
  const f = fixture();
  const { restore } = installWrapper(f);
  try {
    const before = branches(f.base);
    let created: WorktreeCreation | undefined;
    let error: unknown;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected metadata failure");
    // The record names the worktree the add created, taken before the failure.
    expect(created).toBeDefined();
    expect(created!.workspace).toBe(f.workspace);
    expect(created!.baseWorkingTree).toBe(f.base);
    // Setup's own cleanup succeeded, so the caller's retry is skipped.
    expect(created!.removed).toBe(true);
    // The worktree and its registration are gone, and no branch was left.
    expect(existsSync(f.workspace)).toBe(false);
    expect(worktreeList(f.base)).not.toContain(f.workspace);
    expect(branches(f.base)).toEqual(before);
  } finally {
    restore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a pre-existing worktree is untouched by the same failure", () => {
  const f = fixture();
  const existing = join(f.root, "existing");
  try {
    const started = onStart("agent-b", existing, { deferCheckout: true });
    expect(started.changed).toBe(true);
    expect(existsSync(existing)).toBe(true);
    const listedBefore = worktreeList(f.base);
    const branchesBefore = branches(f.base);

    const { restore } = installWrapper(f);
    try {
      expect(() => onStart("agent-a", f.workspace, { deferCheckout: true })).toThrow("injected metadata failure");
    } finally {
      restore();
    }

    expect(existsSync(f.workspace)).toBe(false);
    expect(existsSync(existing)).toBe(true);
    expect(spawnSync(GIT, ["rev-parse", "--absolute-git-dir"], { cwd: existing, encoding: "utf8" }).status).toBe(0);
    expect(worktreeList(f.base)).toBe(listedBefore);
    expect(branches(f.base)).toEqual(branchesBefore);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the original failure is what the caller sees when cleanup succeeds", () => {
  const f = fixture();
  const { restore } = installWrapper(f);
  try {
    let error: unknown;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected metadata failure");
    expect((error as Error).message).not.toContain("worktree cleanup failed");
  } finally {
    restore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a removal failure names the worktree path and keeps the original failure", () => {
  const f = fixture();
  const { restore } = installWrapper(f, {
    beforeFail: `"${GIT}" -C "${f.base}" worktree lock "${f.workspace}" >/dev/null 2>&1 || true`,
  });
  try {
    let error: unknown;
    let created: WorktreeCreation | undefined;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected metadata failure");
    expect((error as Error).message).toContain(`worktree cleanup failed for ${f.workspace}`);
    expect(existsSync(f.workspace)).toBe(true);
    // The record says the worktree is still there, so the call the launch makes
    // next retries and names the path again.
    expect(created).toBeDefined();
    expect(created!.removed).toBeUndefined();
    expect(() => removeCreatedWorktree(created!)).toThrow(`worktree cleanup failed for ${f.workspace}`);
  } finally {
    restore();
    spawnSync(GIT, ["worktree", "unlock", f.workspace], { cwd: f.base });
    spawnSync(GIT, ["worktree", "remove", "--force", f.workspace], { cwd: f.base });
    rmSync(f.root, { recursive: true, force: true });
  }
});

/** A git wrapper that logs every invocation to `logPath`, then runs real Git. */
function installLoggingWrapper(f: Fixture, logPath: string): { restore: () => void } {
  const bin = join(f.root, "bin-log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    ["#!/bin/sh", `printf '%s\\n' "$*" >> "${logPath}"`, `exec "${GIT}" "$@"`, ""].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return { restore: () => { process.env.PATH = oldPath; } };
}

test("a second cleanup of an already-removed record makes no Git call and does not throw", () => {
  const f = fixture();
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    expect(created).toBeDefined();
    expect(removeCreatedWorktree(created!)).toEqual({ changed: true, reason: "worktree removed" });
    expect(created!.removed).toBe(true);
    expect(existsSync(f.workspace)).toBe(false);

    const log = join(f.root, "git-calls.log");
    const { restore } = installLoggingWrapper(f, log);
    try {
      expect(() => removeCreatedWorktree(created!)).not.toThrow();
    } finally {
      restore();
    }
    expect(existsSync(log)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a path re-used by a different worktree after removal is left untouched", () => {
  const f = fixture();
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    removeCreatedWorktree(created!);
    expect(existsSync(f.workspace)).toBe(false);

    const added = spawnSync(GIT, ["worktree", "add", "-b", "reused", f.workspace], { cwd: f.base, encoding: "utf8" });
    expect(added.status, added.stderr).toBe(0);
    expect(existsSync(join(f.workspace, ".git"))).toBe(true);

    expect(() => removeCreatedWorktree(created!)).not.toThrow();
    expect(existsSync(join(f.workspace, ".git"))).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
    expect(branches(f.base)).toContain("reused");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
