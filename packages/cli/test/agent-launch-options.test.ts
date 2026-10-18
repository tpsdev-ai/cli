import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("an existing worktree is confined without a selected runtime", () => fixture((input, base) => {
  const result = agentLaunchOptions({ ...input, runtime: undefined, cwd: base });
  expect(result.refusal).toBeNull();
  expect(result.options.cwd).toBe(input.workspace);
  expect(result.options.allow).not.toContain(base);
  expect(result.options.read).not.toContain(base);
}));
