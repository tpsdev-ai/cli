/**
 * cli#660 — a launch that adds a worktree and fails during setup must clean up
 * only the worktree it created.
 *
 * Immediately after a real `git worktree add`, setup writes a random nonce to
 * `<admin git dir>/tps-launch-owner` with exclusive create, reports the record
 * through `onCreated`, and then reads the identity facts. A marker it cannot
 * write is a setup failure: `onStart` throws, the record carries no marker, and
 * cleanup refuses with the manual command. The setup-failure, launch-fallback
 * and teardown routes attempt removal of a created worktree only when the admin
 * directory still holds the exact nonce; the removal itself can fail. The
 * direct-call cases in this file are unit tests of `removeCreatedWorktree` and
 * `onStop`; the cases that run the real launcher are in
 * `sandboxed-launch-516.test.ts`. Most failure cases inject a metadata error
 * after identity capture, at `rev-parse --absolute-git-dir`; the identity test
 * fails `rev-parse HEAD` during capture, and the marker test fails only the
 * marker write.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  onStart,
  onStop,
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

/** A base repository and a workspace under one temporary root. */
function fixtureIn(root: string, container?: string): Fixture {
  const dir = container ? join(root, container) : root;
  if (container) mkdirSync(dir);
  const base = join(dir, "tps");
  mkdirSync(base);
  const git = (args: string[]) => {
    const result = spawnSync(GIT, args, { cwd: base, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  git(["init", "-q"]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
  return { root, base, workspace: join(dir, "ws") };
}

/** A base repository at <root>/tps and a workspace at <root>/ws, nothing else. */
function fixture(): Fixture {
  return fixtureIn(realpathSync(mkdtempSync(join(tmpdir(), "launch-cleanup-660-"))));
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

function manualCommand(f: Fixture): string {
  return `git -C '${f.base}' worktree remove --force '${f.workspace}'`;
}

/**
 * A git wrapper that fails `rev-parse --absolute-git-dir` (the step after
 * identity capture) unless `injectMetadataFailure` is false. `beforeFail` runs
 * before the injected failure, `failRemoval` makes the cleanup's
 * `worktree remove` fail, `blockMarker` creates a directory where the
 * ownership marker goes, and `failHeadIn` fails the identity read's
 * `rev-parse HEAD` in that directory.
 */
function installWrapper(
  f: Fixture,
  opts: {
    beforeFail?: string;
    failRemoval?: boolean;
    blockMarker?: boolean;
    failHeadIn?: string;
    injectMetadataFailure?: boolean;
  } = {},
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
      ...(opts.injectMetadataFailure === false
        ? []
        : [
            'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then',
            ...(opts.beforeFail ? [opts.beforeFail.split("\n").map((line) => `  ${line}`).join("\n")] : []),
            '  echo "injected metadata failure" >&2',
            "  exit 79",
            "fi",
          ]),
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

test("unit — a failure at the step after identity capture removes the worktree it marked", () => {
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

test("unit — a pre-existing worktree is untouched by the same failure", () => {
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

test("unit — the original failure is what the caller sees when cleanup succeeds", () => {
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

test("unit — a removal failure names the worktree path and keeps the original failure", () => {
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

test("unit — a second cleanup of an already-removed record makes no Git call and does not throw", () => {
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

test("unit — a same-path detached replacement at the same commit survives setup cleanup and the retry", () => {
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
    // The replacement reproduces every identity fact — same admin directory path,
    // registry entry, common directory, HEAD and detached ref — but carries
    // no marker, so setup's cleanup refuses and names the manual command.
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("injected metadata failure");
    expect((error as Error).message).toContain(`worktree cleanup refused for ${f.workspace}`);
    expect((error as Error).message).toContain(manualCommand(f));
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

test("unit — an identity-capture failure at rev-parse HEAD still removes the worktree it owns", () => {
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

test("unit — a marker-write failure alone fails setup, records a null marker and refuses cleanup", () => {
  const f = fixture();
  const { restore } = installWrapper(f, { blockMarker: true, injectMetadataFailure: false });
  try {
    let created: WorktreeCreation | undefined;
    let error: unknown;
    let returned: unknown;
    try {
      returned = onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    } catch (err) {
      error = err;
    }
    // No successful binding: the launch treats this as a setup failure.
    expect(returned).toBeUndefined();
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain("worktree ownership marker could not be written");
    expect((error as Error).message).toContain(`worktree cleanup refused for ${f.workspace}`);
    expect((error as Error).message).toContain(manualCommand(f));
    // The record exists with no marker; the worktree is left for the operator.
    expect(created).toBeDefined();
    expect(created!.ownerMarker).toBeNull();
    expect(created!.removed).toBeUndefined();
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
  } finally {
    restore();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — an added whitespace byte in the ownership marker refuses cleanup", () => {
  const f = fixture();
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    const marker = join(adminDir(f.workspace), "tps-launch-owner");
    writeFileSync(marker, `${readFileSync(marker, "utf-8")}\n`);
    expect(() => removeCreatedWorktree(created!)).toThrow(`worktree cleanup refused for ${f.workspace}`);
    expect(() => removeCreatedWorktree(created!)).toThrow(manualCommand(f));
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — a changed byte in the ownership marker refuses cleanup", () => {
  const f = fixture();
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    const marker = join(adminDir(f.workspace), "tps-launch-owner");
    const original = readFileSync(marker, "utf-8");
    const last = original.slice(-1);
    writeFileSync(marker, `${original.slice(0, -1)}${last === "0" ? "1" : "0"}`);
    expect(() => removeCreatedWorktree(created!)).toThrow(`worktree cleanup refused for ${f.workspace}`);
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — onStop refuses a same-path replacement on the launch-check and teardown route", () => {
  const f = fixture();
  const commit = headOf(f.base);
  try {
    const started = onStart("agent-a", f.workspace, { deferCheckout: true });
    expect(started.cleanupBinding).toBeDefined();
    // Replace the worktree with a fresh one at the same path and commit.
    expect(spawnSync(GIT, ["worktree", "remove", "--force", f.workspace], { cwd: f.base }).status).toBe(0);
    expect(spawnSync(GIT, ["worktree", "add", "--detach", f.workspace, commit], { cwd: f.base }).status).toBe(0);
    const gitDir = adminDir(f.workspace);
    const gitFile = readFileSync(join(f.workspace, ".git"), "utf-8");
    const registry = readFileSync(join(gitDir, "gitdir"), "utf-8");
    const head = headOf(f.workspace);

    // Both the later launch-check failure and normal teardown call onStop with
    // the setup binding; the replacement must survive each call.
    for (let attempt = 0; attempt < 2; attempt++) {
      let error: unknown;
      try {
        onStop("agent-a", f.workspace, started.cleanupBinding);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(WorktreeLifecycleError);
      expect((error as Error).message).toContain(`worktree cleanup binding changed for ${f.workspace}`);
      expect((error as Error).message).toContain(manualCommand(f));
    }
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).toContain(f.workspace);
    expect(existsSync(join(gitDir, "tps-launch-owner"))).toBe(false);
    expect(readFileSync(join(f.workspace, ".git"), "utf-8")).toBe(gitFile);
    expect(readFileSync(join(gitDir, "gitdir"), "utf-8")).toBe(registry);
    expect(headOf(f.workspace)).toBe(head);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — onStop removes the owned worktree after the runtime moved HEAD", () => {
  const f = fixture();
  try {
    const started = onStart("agent-a", f.workspace, { deferCheckout: true });
    expect(started.cleanupBinding).toBeDefined();
    const before = headOf(f.workspace);
    const committed = spawnSync(
      GIT,
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "runtime move"],
      { cwd: f.workspace, encoding: "utf8" },
    );
    expect(committed.status, committed.stderr).toBe(0);
    expect(headOf(f.workspace)).not.toBe(before);

    // Teardown does not compare HEAD: the marker still identifies the worktree.
    expect(onStop("agent-a", f.workspace, started.cleanupBinding)).toEqual({
      changed: true,
      reason: "worktree removed",
    });
    expect(existsSync(f.workspace)).toBe(false);
    expect(worktreeList(f.base)).not.toContain(f.workspace);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — the printed manual command targets a base and workspace with shell metacharacters", () => {
  const f = fixtureIn(
    realpathSync(mkdtempSync(join(tmpdir(), "launch-cleanup-660-"))),
    "run $x;'q",
  );
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    // Remove the marker so cleanup refuses and prints the command.
    rmSync(join(adminDir(f.workspace), "tps-launch-owner"));
    let command = "";
    try {
      removeCreatedWorktree(created!);
    } catch (err) {
      const prefix = "remove it manually with: ";
      const message = (err as Error).message;
      command = message.slice(message.indexOf(prefix) + prefix.length);
    }
    expect(command.startsWith("git -C '")).toBe(true);

    // Run it through sh with a dry git shim that records argv and exits 0.
    const shim = join(f.root, "bin-dry");
    mkdirSync(shim);
    const log = join(f.root, "argv.log");
    writeFileSync(
      join(shim, "git"),
      ["#!/bin/sh", `for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done`, "exit 0", ""].join("\n"),
    );
    chmodSync(join(shim, "git"), 0o755);
    const run = spawnSync("sh", ["-c", command], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(log, "utf-8").split("\n").filter(Boolean)).toEqual([
      "-C",
      f.base,
      "worktree",
      "remove",
      "--force",
      f.workspace,
    ]);
    // Real Git confirms the base path and the workspace are the fixture's.
    expect(worktreeList(f.base)).toContain(f.workspace);
    expect(existsSync(f.workspace)).toBe(true);
  } finally {
    spawnSync(GIT, ["worktree", "remove", "--force", f.workspace], { cwd: f.base });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unit — a path re-used by a different worktree after removal is left untouched", () => {
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

test("unit — removeCreatedWorktree: an unregistered path refusal prints the manual command", () => {
  const f = fixture();
  try {
    let created: WorktreeCreation | undefined;
    onStart("agent-a", f.workspace, { deferCheckout: true, onCreated: (record) => { created = record; } });
    // Drop the registration and leave a plain directory at the same path, so the
    // recorded base no longer lists it as a worktree.
    expect(spawnSync(GIT, ["worktree", "remove", "--force", f.workspace], { cwd: f.base }).status).toBe(0);
    mkdirSync(f.workspace);
    let error: unknown;
    try {
      removeCreatedWorktree(created!);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain(`the path is not a worktree of ${f.base}`);
    expect((error as Error).message).toContain(manualCommand(f));
    expect(existsSync(f.workspace)).toBe(true);
    expect(worktreeList(f.base)).not.toContain(`worktree ${f.workspace}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
