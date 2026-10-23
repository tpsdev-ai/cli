/**
 * cli#660 — a launch that adds a worktree and then fails before the parent
 * records the setup binding must remove the worktree it added.
 *
 * Right after a real `git worktree add`, setup writes a random nonce to
 * `<admin git dir>/tps-launch-owner` with exclusive create, reports the record
 * through `onCreated`, and only then reads the identity facts. Cleanup removes
 * a worktree only when its admin directory still holds that nonce; otherwise
 * it refuses, names the path and prints the manual command. The failure cases
 * inject a metadata error after identity capture, at
 * `rev-parse --absolute-git-dir`.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function headOf(workspace: string): string {
  const head = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
  expect(head.status, head.stderr).toBe(0);
  return head.stdout.trim();
}

function adminDir(workspace: string): string {
  const file = readFileSync(join(workspace, ".git"), "utf-8").trim();
  expect(file.startsWith("gitdir: ")).toBe(true);
  return realpathSync(resolve(workspace, file.slice("gitdir: ".length)));
}

/**
 * A git wrapper that fails `rev-parse --absolute-git-dir` (the step after
 * identity capture). `beforeFail` runs before the injected failure,
 * `failRemoval` makes the cleanup's `worktree remove` fail, `blockMarker`
 * creates a directory where the ownership marker goes, and `failHeadIn`
 * fails the identity read's `rev-parse HEAD` in that directory.
 */
function installWrapper(
  f: Fixture,
  opts: { beforeFail?: string; failRemoval?: boolean; blockMarker?: boolean; failHeadIn?: string } = {},
): { bin: string; restore: () => void } {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const blockMarker = opts.blockMarker
    ? [
        `    GD=$(sed -n 's/^gitdir: //p' "${f.workspace}/.git")`,
        '    case "$GD" in',
        "      /*) ;;",
        `      *) GD="${f.workspace}/$GD" ;;`,
        "    esac",
        '    mkdir -p "$GD/tps-launch-owner"',
      ]
    : ["    :"];
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      "prev=",
      "is_add=0",
      'for arg in "$@"; do',
      '  if [ "$prev" = "worktree" ] && [ "$arg" = "add" ]; then is_add=1; fi',
      '  prev="$arg"',
      "done",
      'if [ "$is_add" = "1" ]; then',
      `  "${GIT}" "$@"`,
      "  rc=$?",
      '  if [ "$rc" = "0" ]; then',
      ...blockMarker,
      "  fi",
      "  exit $rc",
      "fi",
      ...(opts.failHeadIn
        ? [
            `if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ] && [ "$(pwd -P)" = "${opts.failHeadIn}" ]; then`,
            '  echo "injected identity failure" >&2',
            "  exit 78",
            "fi",
          ]
        : []),
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

test("a failure after the marker and identity capture removes the worktree it marked", () => {
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
    // The record names the worktree the add created, with its ownership marker.
    expect(created).toBeDefined();
    expect(created!.workspace).toBe(f.workspace);
    expect(created!.baseWorkingTree).toBe(f.base);
    expect(typeof created!.ownerMarker).toBe("string");
    // Setup's own cleanup succeeded, so the caller's retry is skipped.
    expect(created!.removed).toBe(true);
    // The worktree, its registration and its admin directory are gone, and no branch was left.
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

test("a same-path detached replacement at the same commit survives setup cleanup and the retry", () => {
  const f = fixture();
  const commit = headOf(f.base);
  const { restore } = installWrapper(f, {
    beforeFail: [
      `"${GIT}" -C "${f.base}" worktree remove --force "${f.workspace}"`,
      `"${GIT}" -C "${f.base}" worktree add --detach "${f.workspace}" "${commit}"`,
    ].join("\n"),
  });
  try {
    let created: WorktreeCreation | undefined;
    let error: unknown;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    // The replacement reproduces every identity fact — same admin directory,
    // registry entry, common directory, HEAD and detached ref — but carries
    // no marker, so setup's cleanup refuses and names the manual command.
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected metadata failure");
    expect((error as Error).message).toContain(`worktree cleanup refused for ${f.workspace}`);
    expect((error as Error).message).toContain(
      `git -C ${f.base} worktree remove --force ${f.workspace}`,
    );
    expect(created).toBeDefined();
    expect(created!.removed).toBeUndefined();

    // The replacement keeps its .git file, registry entry and HEAD.
    const gitFile = readFileSync(join(f.workspace, ".git"), "utf-8");
    const gitDir = adminDir(f.workspace);
    const registry = readFileSync(join(gitDir, "gitdir"), "utf-8");
    const head = headOf(f.workspace);
    expect(existsSync(join(gitDir, "tps-launch-owner"))).toBe(false);
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);

    // The launcher's onStart fallback retries from the record and refuses too.
    expect(() => removeCreatedWorktree(created!)).toThrow(`worktree cleanup refused for ${f.workspace}`);
    expect(existsSync(f.workspace)).toBe(true);
    expect(existsSync(join(gitDir, "tps-launch-owner"))).toBe(false);
    expect(readFileSync(join(f.workspace, ".git"), "utf-8")).toBe(gitFile);
    expect(readFileSync(join(gitDir, "gitdir"), "utf-8")).toBe(registry);
    expect(headOf(f.workspace)).toBe(head);
  } finally {
    restore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an identity-capture failure after the marker still removes the worktree it owns", () => {
  const f = fixture();
  const { restore } = installWrapper(f, { failHeadIn: f.workspace });
  try {
    let created: WorktreeCreation | undefined;
    let error: unknown;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    // Report-first: the caller has the record even though the identity read threw.
    expect(created).toBeDefined();
    expect(typeof created!.ownerMarker).toBe("string");
    expect(created!.identity).toBeUndefined();
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected identity failure");
    // The marker matched, so cleanup removed the worktree this call owns.
    expect(created!.removed).toBe(true);
    expect(existsSync(f.workspace)).toBe(false);
    expect(worktreeList(f.base)).not.toContain(f.workspace);
  } finally {
    restore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a marker-write failure records a null marker and cleanup refuses with the manual command", () => {
  const f = fixture();
  const { restore } = installWrapper(f, { blockMarker: true });
  try {
    let created: WorktreeCreation | undefined;
    let error: unknown;
    try {
      onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    expect(created).toBeDefined();
    expect(created!.ownerMarker).toBeNull();
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain(`worktree cleanup refused for ${f.workspace}`);
    expect((error as Error).message).toContain(
      `git -C ${f.base} worktree remove --force ${f.workspace}`,
    );
    // No marker means no ownership; the worktree is left for the operator.
    expect(created!.removed).toBeUndefined();
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
  } finally {
    restore();
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
