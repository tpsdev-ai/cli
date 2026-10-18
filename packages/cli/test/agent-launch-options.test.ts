import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { onStart, WorktreeLifecycleError } from "../src/utils/agent-lifecycle.js";
import { agentLaunchOptions, approveRuntimeNonoOptions, buildNonoArgs, WorktreeGrantError, type AgentLaunchGrantInput } from "../src/utils/nono.js";
import { sandboxHomeBase } from "./helpers/launcher-grants.js";

function fixture(run: (input: AgentLaunchGrantInput, base: string, root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(sandboxHomeBase(), "launch-options-")));
  const previousCwd = process.cwd();
  try {
    const base = join(root, "tps");
    const workspace = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(base);
    mkdirSync(home);
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: base, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git(["init", "-q"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
    const created = onStart("probe", workspace, { deferCheckout: true });
    expect(created.changed).toBe(true);
    const existing = onStart("probe", workspace, { deferCheckout: true });
    expect(existing.changed).toBe(false);
    expect(existing.gitDir).toBe(created.gitDir);
    const configPath = join(home, "agent.yaml");
    writeFileSync(configPath, "agentId: probe\n");
    process.chdir(base);
    run({
      configPath, workspace, cwd: root, launchId: "probe", runtime: "codex", home,
      env: { HOME: home }, mailDir: join(home, ".tps", "mail"), tmpDir: join(root, "tmp"),
      agentDir: join(home, ".tps", "agents", "probe"),
    }, base, root);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const config of ["outside", "base", "symlink"] as const) {
  test(`final launcher arguments with base cwd and ${config} config`, () => fixture((input, base, root) => {
    const target = config === "outside" ? input.configPath : join(base, "agent.yaml");
    writeFileSync(target, "agentId: probe\n");
    let configPath = target;
    if (config === "symlink") {
      configPath = join(root, "config-link.yaml");
      symlinkSync(target, configPath);
    }
    const result = agentLaunchOptions({ ...input, cwd: base, configPath });
    expect(result.refusal).toBeNull();
    const args = buildNonoArgs("tps-agent-run-codex", result.options, ["payload"], input.env);
    expect(args[args.indexOf(realpathSync(target)) - 1]).toBe("--read-file");
    expect(result.options.readFiles).toContain(realpathSync(target));
    expect(args).not.toContain("--allow-cwd");
    expect(result.options.cwd).toBe(input.workspace);
    expect(args.slice(args.indexOf("--allow"), args.indexOf("--allow") + 2)).toEqual(["--allow", input.workspace]);
    for (let index = 0; index < args.indexOf("--"); index++) {
      if (!["--allow", "--read", "--workdir", "--allow-file", "--read-file"].includes(args[index]!)) continue;
      const path = args[++index]!;
      const remainder = relative(path, base);
      expect(remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder)), path).toBe(false);
    }
  }));
}

for (const source of ["mailDir", "tmpDir", "agentDir", "runtime", "symlink"] as const) {
  test(`refuses a base-containing grant from ${source}`, () => fixture((input, base, root) => {
    if (source === "runtime") input.env = { HOME: input.home, CODEX_HOME: base };
    else if (source === "symlink") {
      const alias = join(root, "alias");
      symlinkSync(base, alias);
      input.tmpDir = alias;
    } else input[source] = source === "tmpDir" ? root : base;
    expect(() => agentLaunchOptions(input)).toThrow(WorktreeGrantError);
  }));
}

test("config file approval retains credential checks", () => fixture((input) => {
  const foreignKey = join(input.home!, ".tps", "identity", "other.key");
  const result = approveRuntimeNonoOptions("codex", { readFiles: [foreignKey] }, input.env, "probe", foreignKey);
  expect(result.refusal).toContain("~/.tps/identity");
}));

test("post-add metadata failure rolls back the real worktree", () => fixture((_input, base, root) => {
  const gitBin = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then echo "injected metadata failure" >&2; exit 79; fi',
    `exec "${gitBin}" "$@"`, "",
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  const oldPath = process.env.PATH;
  const workspace = join(root, "new-worktree");
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    expect(() => onStart("probe", workspace, { deferCheckout: true })).toThrow(WorktreeLifecycleError);
    expect(existsSync(workspace)).toBe(false);
    const listed = spawnSync(gitBin, ["worktree", "list", "--porcelain"], { cwd: base, encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain(workspace);
  } finally {
    process.env.PATH = oldPath;
  }
}));

test("refuses a base grant declared by the selected profile", () => fixture((input, base) => {
  const profiles = join(input.home!, ".config", "nono", "profiles");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, "tps-agent-run-codex.json"), JSON.stringify({ filesystem: { read: [base] } }));
  expect(() => agentLaunchOptions(input)).toThrow(WorktreeGrantError);
}));

test("an existing worktree omits the base from explicit launch grants without a selected runtime", () => fixture((input, base) => {
  const result = agentLaunchOptions({ ...input, runtime: undefined, cwd: base });
  expect(result.refusal).toBeNull();
  expect(result.options.cwd).toBe(input.workspace);
  expect(result.options.allow).not.toContain(base);
  expect(result.options.read).not.toContain(base);
}));

for (const marker of ["gitfile", "commondir", "common-only"] as const) {
  test(`launch requires trusted worktree metadata (${marker})`, () => fixture((input, base, root) => {
    const other = join(root, "other");
    mkdirSync(other);
    const g = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: other, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    g(["init", "-q"]);
    g(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
    if (marker === "gitfile") {
      const linked = join(root, "other-worktree");
      g(["worktree", "add", "--detach", linked]);
      writeFileSync(join(input.workspace, ".git"), readFileSync(join(linked, ".git")));
    } else {
      const metadata = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: input.workspace, encoding: "utf8" });
      expect(metadata.status).toBe(0);
      if (marker === "common-only") g(["config", "core.worktree", base]);
      writeFileSync(join(metadata.stdout.trim(), "commondir"), join(other, ".git"));
    }
    let approval: ReturnType<typeof agentLaunchOptions> | undefined;
    expect(() => { approval = agentLaunchOptions(input); }).toThrow(WorktreeLifecycleError);
    expect(() => agentLaunchOptions(input)).toThrow("worktree metadata binding failed");
    expect(approval).toBeUndefined();
  }));
}

function unrelatedWorktree(root: string, name: string): { repo: string; ws: string } {
  const repo = join(root, `${name}-repo`);
  mkdirSync(repo, { recursive: true });
  const g = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  g(["init", "-q"]);
  g(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
  const ws = join(root, `${name}-ws`);
  g(["worktree", "add", "--detach", ws]);
  return { repo, ws };
}

test("an unrelated project's worktree launches with no metadata grants", () => fixture((input, _base, root) => {
  // A trusted base exists beside it (root/tps), but its registry does not list this workspace.
  const { repo, ws } = unrelatedWorktree(root, "unrelated");
  const result = agentLaunchOptions({ ...input, workspace: ws, runtime: undefined, cwd: ws });
  expect(result.refusal).toBeNull();
  expect(result.options.read).not.toContain(join(repo, ".git"));
  expect(result.options.allow).not.toContain(join(repo, ".git"));
}));

test("an unrelated project's worktree launched from the base gets the workspace as its cwd grant", () => fixture((input, base, root) => {
  const { ws } = unrelatedWorktree(root, "unregistered-cwd");
  const result = agentLaunchOptions({ ...input, workspace: ws, runtime: undefined, cwd: base });
  expect(result.refusal).toBeNull();
  expect(result.options.cwd).toBe(ws);
  expect(result.options.allow).not.toContain(base);
  const args = buildNonoArgs("tps-agent-run", result.options, ["payload"], input.env);
  expect(args[args.indexOf("--allow") + 1]).toBe(ws);
}));

test("an unregistered worktree refuses a base grant declared by the profile", () => fixture((input, base, root) => {
  const { ws } = unrelatedWorktree(root, "unregistered-profile");
  const profiles = join(input.home!, ".config", "nono", "profiles");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, "tps-agent-run.json"), JSON.stringify({ filesystem: { read: [base] } }));
  expect(() => agentLaunchOptions({ ...input, workspace: ws, runtime: undefined, cwd: base })).toThrow(WorktreeGrantError);
}));

for (const marker of ["missing", "directory"] as const) {
  test(`a registered worktree with a ${marker} marker is refused on the default launch path`, () => fixture((input) => {
    const gitPath = join(input.workspace, ".git");
    rmSync(gitPath, { recursive: true, force: true });
    if (marker === "directory") mkdirSync(gitPath);
    expect(() => agentLaunchOptions({ ...input, runtime: undefined })).toThrow(WorktreeLifecycleError);
  }));
}

test("a registered worktree with a missing directory is refused before grants", () => fixture((input, _base, root) => {
  // Grants are computed from configPath; a symlink loop there throws when grant
  // computation runs, so the named ownership error proves it did not.
  const loop = join(root, "config-loop");
  symlinkSync(loop, loop);
  rmSync(input.workspace, { recursive: true, force: true });
  let error: unknown;
  try {
    agentLaunchOptions({ ...input, runtime: undefined, configPath: loop });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(WorktreeLifecycleError);
  expect((error as Error).message).toBe(
    `worktree workspace is missing for a registered worktree: ${input.workspace}`,
  );
}));

test("an absent unregistered path keeps the caller's cwd policy", () => fixture((input, base, root) => {
  const absent = join(root, "absent-workspace");
  const result = agentLaunchOptions({ ...input, workspace: absent, runtime: undefined, cwd: base });
  expect(result.refusal).toBeNull();
  expect(result.options.cwd).toBe(base);
}));

test("a registry read failure is a named WorktreeLifecycleError", () => fixture((input, base) => {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: base, encoding: "utf8" });
  expect(common.status).toBe(0);
  const registry = join(base, common.stdout.trim(), "worktrees");
  rmSync(registry, { recursive: true, force: true });
  writeFileSync(registry, "not a directory\n");
  expect(() => agentLaunchOptions({ ...input, runtime: undefined })).toThrow(WorktreeLifecycleError);
  expect(() => agentLaunchOptions({ ...input, runtime: undefined })).toThrow("worktree registry could not be read");
}));

test("a symlink marker is refused with no trusted base repository", () => fixture((input, _base, root) => {
  const { ws } = unrelatedWorktree(join(root, "elsewhere"), "symlinked-nobase");
  rmSync(join(ws, ".git"));
  symlinkSync(join(root, "missing-target"), join(ws, ".git"));
  expect(() => agentLaunchOptions({ ...input, workspace: ws, runtime: undefined })).toThrow(WorktreeLifecycleError);
}));

test("a worktree with no trusted base repository launches with no metadata grants", () => fixture((input, _base, root) => {
  // No sibling tps next to this workspace, and the test home has no ~/ops/tps.
  const { repo, ws } = unrelatedWorktree(join(root, "elsewhere"), "nobase");
  const result = agentLaunchOptions({ ...input, workspace: ws, runtime: undefined, cwd: ws });
  expect(result.refusal).toBeNull();
  expect(result.options.read).not.toContain(join(repo, ".git"));
}));

test("a symlinked base uses resolved metadata grants", () => fixture((input, base, root) => {
  const resolvedBase = join(root, "projects", "repo");
  mkdirSync(join(root, "projects"));
  renameSync(base, resolvedBase);
  symlinkSync(resolvedBase, base);
  const result = agentLaunchOptions(input);
  expect(result.refusal).toBeNull();
  expect(result.options.read).toContain(join(resolvedBase, ".git"));
  expect(result.options.read).not.toContain(join(base, ".git"));
  expect(result.options.allow).toContain(realpathSync(join(resolvedBase, ".git", "worktrees", "ws")));
}));

test("launch options accept a registered worktree beside a prunable entry", () => fixture((input, base, root) => {
  const stale = join(root, "a-stale");
  const added = spawnSync("git", ["worktree", "add", "--detach", stale], { cwd: base, encoding: "utf8" });
  expect(added.status, added.stderr).toBe(0);
  rmSync(stale, { recursive: true });
  expect(agentLaunchOptions(input).refusal).toBeNull();
}));
