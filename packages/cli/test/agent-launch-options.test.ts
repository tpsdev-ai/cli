import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { onStart, onStop, worktreeLaunchBinding, WorktreeLifecycleError } from "../src/utils/agent-lifecycle.js";
import { agentLaunchOptions, approveRuntimeNonoOptions, buildNonoArgs, WorktreeGrantError, type AgentLaunchGrantInput } from "../src/utils/nono.js";
import { sandboxHomeBase } from "./helpers/launcher-grants.js";

function detectRelativeWorktreesSupport(): boolean {
  const root = mkdtempSync(join(tmpdir(), "relativeworktrees-probe-"));
  try {
    const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    const initialized = git(["init", "-q"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    const baseline = git(["rev-parse", "--is-inside-work-tree"]);
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout.trim()).toBe("true");
    writeFileSync(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 1\n[extensions]\nrelativeworktrees = true\n");
    const probe = git(["rev-parse", "--is-inside-work-tree"]);
    if (probe.status === 0) {
      expect(probe.stdout.trim()).toBe("true");
      return true;
    }
    expect(probe.status).not.toBeNull();
    expect(probe.stderr).toContain("unknown repository extension");
    expect(probe.stderr).toContain("relativeworktrees");
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const supportsRelativeWorktrees = detectRelativeWorktreesSupport();
const relativeWorktreesLabel = `relativeworktrees ${supportsRelativeWorktrees ? "supported" : "unsupported"}`;

test(`real Git extension probe agrees with git version (${relativeWorktreesLabel})`, () => {
  const version = spawnSync("git", ["version"], { encoding: "utf8" });
  expect(version.status, version.stderr).toBe(0);
  const parsed = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(version.stdout);
  expect(parsed).not.toBeNull();
  const major = Number(parsed![1]);
  const minor = Number(parsed![2]);
  expect(supportsRelativeWorktrees).toBe(major > 2 || (major === 2 && minor >= 48));
});

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
    expect(worktreeLaunchBinding(workspace)).toEqual({
      kind: "registered", gitDir: created.gitDir, gitCommonDir: created.gitCommonDir, baseWorkingTree: base,
    });
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

test("refuses a profile read grant for a base subdirectory", () => fixture((input, base) => {
  const source = join(base, "src");
  mkdirSync(source);
  writeFileSync(join(source, "index.ts"), "export {};\n");
  const profiles = join(input.home!, ".config", "nono", "profiles");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, "tps-agent-run-codex.json"), JSON.stringify({ filesystem: { read: [source] } }));
  expect(() => agentLaunchOptions(input)).toThrow(WorktreeGrantError);
  expect(() => agentLaunchOptions(input)).toThrow(`grant overlaps the base working tree: ${source}`);
}));

test("refuses a tmpDir inside the base working tree", () => fixture((input, base) => {
  const tmpDir = join(base, "tmp");
  mkdirSync(tmpDir);
  expect(() => agentLaunchOptions({ ...input, tmpDir })).toThrow(WorktreeGrantError);
}));

test("refuses TMPDIR at the registered Git common directory", () => fixture((input, base) => {
  const previousTmpDir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = realpathSync(join(base, ".git"));
    expect(() => agentLaunchOptions({ ...input, tmpDir: process.env.TMPDIR || "/tmp" })).toThrow(WorktreeGrantError);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}));

for (const kind of ["allow", "write", "allow_file", "write_file"] as const) {
  test(`refuses a profile ${kind} grant at the registered Git common directory`, () => fixture((input, base) => {
    const profiles = join(input.home!, ".config", "nono", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "tps-agent-run-codex.json"), JSON.stringify({ filesystem: { [kind]: [join(base, ".git")] } }));
    expect(() => agentLaunchOptions(input)).toThrow(WorktreeGrantError);
  }));
}

test("refuses a writable config snapshot grant inside the base", () => fixture((input, base) => {
  const configPath = join(base, "snapshot.yaml");
  writeFileSync(configPath, "agentId: probe\n");
  expect(() => agentLaunchOptions({ ...input, configPath, tmpDir: configPath })).toThrow(WorktreeGrantError);
}));

for (const kind of ["allow", "write", "allow_file", "write_file"] as const) {
  test(`refuses a profile ${kind} grant for the config snapshot inside the base`, () => fixture((input, base) => {
    const configPath = join(base, "snapshot.yaml");
    writeFileSync(configPath, "agentId: probe\n");
    const profiles = join(input.home!, ".config", "nono", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "tps-agent-run-codex.json"), JSON.stringify({ filesystem: { [kind]: [configPath] } }));
    expect(() => agentLaunchOptions({ ...input, configPath })).toThrow(WorktreeGrantError);
  }));
}

for (const kind of ["read", "read_file"] as const) {
  test(`refuses a profile ${kind} grant at the registered Git directory`, () => fixture((input) => {
    const binding = worktreeLaunchBinding(input.workspace);
    expect(binding.kind).toBe("registered");
    if (binding.kind !== "registered") throw new Error("expected registered worktree");
    const profiles = join(input.home!, ".config", "nono", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "tps-agent-run-codex.json"), JSON.stringify({ filesystem: { [kind]: [binding.gitDir] } }));
    expect(() => agentLaunchOptions(input)).toThrow(WorktreeGrantError);
  }));
}

test("refuses a grant beside the registered worktree metadata entry", () => fixture((input, base) => {
  const tmpDir = join(base, ".git", "worktrees", "ws-adjacent");
  mkdirSync(tmpDir);
  writeFileSync(join(tmpDir, "gitdir"), `${join(base, "adjacent-workspace", ".git")}\n`);
  expect(() => agentLaunchOptions({ ...input, tmpDir })).toThrow(WorktreeGrantError);
}));

test("launch grants retain the bound metadata paths and config snapshot file", () => fixture((input, base) => {
  const configPath = join(base, "snapshot.yaml");
  writeFileSync(configPath, "agentId: probe\n");
  const binding = worktreeLaunchBinding(input.workspace);
  expect(binding.kind).toBe("registered");
  if (binding.kind !== "registered") throw new Error("expected registered worktree");
  expect(binding.gitDir).toBe(realpathSync(join(base, ".git", "worktrees", "ws")));
  expect(binding.gitCommonDir).toBe(realpathSync(join(base, ".git")));
  const result = agentLaunchOptions({ ...input, configPath });
  expect(result.refusal).toBeNull();
  expect(result.options.allow).toContain(binding.gitDir);
  expect(result.options.read).toContain(binding.gitCommonDir);
  expect(result.options.readFiles).toContain(realpathSync(configPath));
  const args = buildNonoArgs("tps-agent-run-codex", result.options, ["payload"], input.env);
  expect(args[args.indexOf(binding.gitDir) - 1]).toBe("--allow");
  expect(args[args.indexOf(binding.gitCommonDir) - 1]).toBe("--read");
  expect(args[args.indexOf(realpathSync(configPath)) - 1]).toBe("--read-file");
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

test("an unrelated project's worktree receives no metadata grants", () => fixture((input, _base, root) => {
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
    expect(() => agentLaunchOptions({ ...input, runtime: undefined })).toThrow(
      marker === "directory"
        ? `worktree git marker is not a regular file for a registered worktree: ${input.workspace}`
        : `worktree git marker is missing for a registered worktree: ${input.workspace}`,
    );
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

test("a worktree with no trusted base repository receives no metadata grants", () => fixture((input, _base, root) => {
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

for (const runtime of [undefined, "codex"] as const) {
  test(`a workspace symlink uses its registered target's launch options (${runtime ?? "default"})`, () => fixture((input, base, root) => {
    const aliases = join(root, "aliases");
    mkdirSync(aliases);
    writeFileSync(join(aliases, "tps"), "not a base directory\n");
    const alias = join(aliases, "workspace");
    symlinkSync(input.workspace, alias);
    const direct = { ...input, runtime, cwd: base };
    const linked = { ...direct, workspace: alias };
    expect(worktreeLaunchBinding(alias)).toEqual(worktreeLaunchBinding(input.workspace));
    expect(worktreeLaunchBinding(alias).kind).toBe("registered");
    expect(onStart("probe", alias, { deferCheckout: true }))
      .toEqual(onStart("probe", input.workspace, { deferCheckout: true }));
    const target = agentLaunchOptions(direct);
    const result = agentLaunchOptions(linked);
    expect(target.refusal).toBeNull();
    expect(result).toEqual(target);
    expect(result.options.cwd).toBe(input.workspace);
    expect(result.options.workdir).toBe(input.workspace);
    expect(result.options.allow).not.toContain(alias);
    expect(buildNonoArgs("tps-agent-run", result.options, ["payload"], input.env))
      .toEqual(buildNonoArgs("tps-agent-run", target.options, ["payload"], input.env));
    expect(() => agentLaunchOptions({ ...direct, tmpDir: base })).toThrow(WorktreeGrantError);
    expect(() => agentLaunchOptions({ ...linked, tmpDir: base })).toThrow(WorktreeGrantError);
    expect(agentLaunchOptions({ ...linked, workspace: `${input.workspace}/../ws` }).refusal)
      .toContain("unsupported parent-directory segment '..'");
  }));
}

test("a workspace symlink to the trusted base uses the base's launch options", () => fixture((input, base, root) => {
  const aliases = join(root, "aliases");
  mkdirSync(aliases);
  writeFileSync(join(aliases, "tps"), "not a base directory\n");
  const alias = join(aliases, "base");
  symlinkSync(base, alias);
  expect(worktreeLaunchBinding(alias)).toEqual(worktreeLaunchBinding(base));
  expect(worktreeLaunchBinding(alias).kind).toBe("none");
  expect(onStart("probe", alias, { deferCheckout: true }))
    .toEqual(onStart("probe", base, { deferCheckout: true }));
  const target = agentLaunchOptions({ ...input, workspace: base, cwd: base });
  const result = agentLaunchOptions({ ...input, workspace: alias, cwd: base });
  expect(target.refusal).toBeNull();
  expect(result).toEqual(target);
  expect(result.options.workdir).toBe(base);
  expect(result.options.allow).not.toContain(alias);
  expect(buildNonoArgs("tps-agent-run", result.options, ["payload"], input.env))
    .toEqual(buildNonoArgs("tps-agent-run", target.options, ["payload"], input.env));
}));

test("a dangling workspace symlink to a registered target is refused before grants", () => fixture((input, _base, root) => {
  const aliases = join(root, "aliases");
  mkdirSync(aliases);
  const alias = join(aliases, "workspace");
  symlinkSync(relative(aliases, input.workspace), alias);
  rmSync(input.workspace, { recursive: true });
  const loop = join(root, "config-loop");
  symlinkSync(loop, loop);
  for (const workspace of [input.workspace, alias]) {
    let error: unknown;
    try {
      agentLaunchOptions({ ...input, workspace, configPath: loop });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toBe(
      `worktree workspace is missing for a registered worktree: ${input.workspace}`,
    );
  }
}));

for (const layout of ["absolute", "relative"] as const) {
  for (const marker of ["absolute", "relative"] as const) {
    test(`a ${layout} registry gitdir ${layout === "relative" && !supportsRelativeWorktrees ? "is refused by the base repository probe" : "binds launch metadata and preserves an existing worktree"} (${marker} marker; ${relativeWorktreesLabel})`, () => fixture((input, base, root) => {
      const workspace = join(root, "relative-worktree");
      const created = onStart("probe", workspace, { deferCheckout: true });
      expect(created.changed).toBe(true);
      const metadata = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: workspace, encoding: "utf8" });
      expect(metadata.status, metadata.stderr).toBe(0);
      const gitDir = realpathSync(metadata.stdout.trim());
      if (layout === "relative") {
        for (const [key, value] of [["core.repositoryformatversion", "1"], ["extensions.relativeworktrees", "true"]] as const) {
          const configured = spawnSync("git", ["config", "--local", key, value], { cwd: base, encoding: "utf8" });
          expect(configured.status, configured.stderr).toBe(0);
        }
      }
      const recordedPath = join(gitDir, "gitdir");
      const recorded = `${layout === "absolute" ? join(workspace, ".git") : relative(dirname(recordedPath), join(workspace, ".git"))}\n`;
      writeFileSync(recordedPath, recorded);
      const gitfile = `gitdir: ${marker === "absolute" ? gitDir : relative(workspace, gitDir)}\n`;
      writeFileSync(join(workspace, ".git"), gitfile);
      expect(isAbsolute(readFileSync(recordedPath, "utf8").trim())).toBe(layout === "absolute");
      const gitBin = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const bin = join(root, "bin");
      mkdirSync(bin);
      const listed = join(root, "worktree-listed");
      const wrapper = join(bin, "git");
      writeFileSync(wrapper, [
        "#!/bin/sh",
        `if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then touch "${listed}"; fi`,
        `exec "${gitBin}" "$@"`, "",
      ].join("\n"));
      chmodSync(wrapper, 0o755);
      const oldPath = process.env.PATH;
      try {
        process.env.PATH = `${bin}:${oldPath}`;
        if (layout === "relative" && !supportsRelativeWorktrees) {
          for (const operation of [
            () => worktreeLaunchBinding(workspace),
            () => agentLaunchOptions({ ...input, workspace, cwd: base }),
            () => onStart("probe", workspace, { deferCheckout: true }),
            () => onStop("probe", workspace),
          ]) {
            expect(operation).toThrow(WorktreeLifecycleError);
            expect(operation).toThrow("git probe failed for the base repository");
          }
          expect(readFileSync(join(workspace, ".git"), "utf8")).toBe(gitfile);
          expect(readFileSync(recordedPath, "utf8")).toBe(recorded);
          expect(existsSync(join(gitDir, "index"))).toBe(false);
          expect(existsSync(listed)).toBe(false);
          expect(existsSync(workspace)).toBe(true);
          expect(existsSync(gitDir)).toBe(true);
          return;
        }
        const gitCommonDir = realpathSync(join(base, ".git"));
        expect(worktreeLaunchBinding(workspace)).toEqual({ kind: "registered", gitDir, gitCommonDir, baseWorkingTree: base });
        const result = agentLaunchOptions({ ...input, workspace, cwd: base });
        expect(result.refusal).toBeNull();
        expect(result.options.cwd).toBe(workspace);
        expect(result.options.allow).toContain(gitDir);
        expect(result.options.read).toContain(gitCommonDir);
        const existing = onStart("probe", workspace, { deferCheckout: true });
        expect(existing.changed).toBe(false);
        expect(existing.gitDir).toBe(gitDir);
        expect(readFileSync(join(workspace, ".git"), "utf8")).toBe(gitfile);
        expect(readFileSync(recordedPath, "utf8")).toBe(recorded);
        expect(existsSync(join(gitDir, "index"))).toBe(false);
        expect(worktreeLaunchBinding(workspace)).toEqual({ kind: "registered", gitDir, gitCommonDir, baseWorkingTree: base });
        expect(agentLaunchOptions({ ...input, workspace, cwd: base })).toEqual(result);
        expect(existsSync(listed)).toBe(false);
        expect(onStop("probe", workspace).changed).toBe(true);
        expect(existsSync(listed)).toBe(false);
        expect(existsSync(workspace)).toBe(false);
        expect(existsSync(gitDir)).toBe(false);
      } finally {
        process.env.PATH = oldPath;
      }
    }));
  }
}

for (const config of ["absent", "false", "format-zero"] as const) {
  test(`relative registry gitdir with ${config} extension config is a named lifecycle error (${relativeWorktreesLabel})`, () => fixture((input, base) => {
    const metadata = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: input.workspace, encoding: "utf8" });
    expect(metadata.status, metadata.stderr).toBe(0);
    const gitDir = realpathSync(metadata.stdout.trim());
    for (const [key, value] of [
      ["core.repositoryformatversion", config === "format-zero" ? "0" : "1"],
      ["extensions.relativeworktrees", config === "false" ? "false" : "true"],
    ] as const) {
      if (config === "absent" && key === "extensions.relativeworktrees") continue;
      const configured = spawnSync("git", ["config", "--local", key, value], { cwd: base, encoding: "utf8" });
      expect(configured.status, configured.stderr).toBe(0);
    }
    writeFileSync(join(gitDir, "gitdir"), `${relative(gitDir, join(input.workspace, ".git"))}\n`);
    for (const operation of [
      () => worktreeLaunchBinding(input.workspace),
      () => agentLaunchOptions(input),
      () => onStart("probe", input.workspace, { deferCheckout: true }),
      () => onStop("probe", input.workspace),
    ]) {
      expect(operation).toThrow(WorktreeLifecycleError);
      expect(operation).toThrow((supportsRelativeWorktrees ? config === "format-zero" : config === "false")
        ? "git probe failed for the base repository"
        : "relative gitdir requires extensions.relativeworktrees=true and core.repositoryformatversion >= 1");
    }
    expect(existsSync(input.workspace)).toBe(true);
    expect(existsSync(gitDir)).toBe(true);
  }));
}

for (const corruption of ["unreadable", "unresolvable", "empty"] as const) {
  test(`lifecycle and launch reject a ${corruption} registry entry`, () => fixture((input, base) => {
    const registry = join(base, ".git", "worktrees", "invalid");
    mkdirSync(registry);
    const recordedPath = join(registry, "gitdir");
    if (corruption === "unreadable") mkdirSync(recordedPath);
    else if (corruption === "unresolvable") {
      const loop = join(registry, "loop");
      symlinkSync("loop", loop);
      writeFileSync(recordedPath, `${loop}/.git\n`);
    } else writeFileSync(recordedPath, "\n");
    for (const operation of [
      () => onStart("probe", input.workspace, { deferCheckout: true }),
      () => onStop("probe", input.workspace),
      () => worktreeLaunchBinding(input.workspace),
    ]) {
      expect(operation).toThrow(WorktreeLifecycleError);
      expect(operation).toThrow("worktree registry entry could not be resolved");
    }
  }));
}

for (const rewrite of [false, true]) {
  test(`cleanup uses the setup binding with registry rewrite ${rewrite}`, () => fixture((_input, _base, root) => {
    const workspace = join(root, "cleanup-worktree");
    const start = onStart("probe", workspace, { deferCheckout: true });
    expect(start.changed).toBe(true);
    expect(start.cleanupBinding).toBeDefined();
    const binding = start.cleanupBinding!;
    expect(binding.workspace).toBe(realpathSync(workspace));
    expect(binding.gitDir).toBe(start.gitDir!);
    if (rewrite) {
      writeFileSync(binding.registryEntry, join(root, "repointed", ".git") + "\n");
      let result: ReturnType<typeof onStop> | undefined;
      let error: unknown;
      try {
        result = onStop("probe", workspace, binding);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(WorktreeLifecycleError);
      expect((error as Error).message).toContain(`worktree cleanup binding changed for ${workspace}`);
      expect(result).toBeUndefined();
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(binding.gitDir)).toBe(true);
    } else {
      expect(onStop("probe", workspace, binding).changed).toBe(true);
      expect(existsSync(workspace)).toBe(false);
      expect(existsSync(binding.gitDir)).toBe(false);
    }
  }));
}

for (const target of ["dangling", "loop"] as const) {
  test(`cleanup names a ${target} workspace symlink resolution failure`, () => fixture((_input, _base, root) => {
    const workspace = join(root, "cleanup-link");
    symlinkSync(target === "loop" ? workspace : join(root, "absent"), workspace);
    let error: unknown;
    try {
      onStop("probe", workspace);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WorktreeLifecycleError);
    expect((error as Error).message).toContain(`worktree path could not be resolved for ${workspace}`);
  }));
}

test("cleanup reports a retained worktree removal failure", () => fixture((_input, base, root) => {
  const workspace = join(root, "locked-worktree");
  const start = onStart("probe", workspace, { deferCheckout: true });
  expect(start.changed).toBe(true);
  expect(start.cleanupBinding).toBeDefined();
  const locked = spawnSync("git", ["worktree", "lock", workspace], { cwd: base, encoding: "utf8" });
  expect(locked.status, locked.stderr).toBe(0);
  let error: unknown;
  try {
    onStop("probe", workspace, start.cleanupBinding);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(WorktreeLifecycleError);
  expect((error as Error).message).toContain(`worktree cleanup failed for probe (${workspace})`);
  expect(existsSync(workspace)).toBe(true);
}));
