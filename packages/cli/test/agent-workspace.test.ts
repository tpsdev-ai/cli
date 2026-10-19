import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspaceModule = resolve(import.meta.dir, "../dist/src/utils/agent-workspace.js");
const lifecycleModule = resolve(import.meta.dir, "../dist/src/utils/agent-lifecycle.js");
const configModule = resolve(import.meta.dir, "../../agent/dist/config.js");
const agentModule = resolve(import.meta.dir, "../dist/src/commands/agent.js");
const runtimeModule = resolve(import.meta.dir, "../../agent/dist/index.js");

test("default child uses the parent's absolute workspace with a symlinked config and relative workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-symlink-"));
  try {
    const launch = join(root, "launch");
    const target = join(root, "target");
    mkdirSync(launch);
    mkdirSync(target);
    const config = join(target, "agent.yaml");
    const link = join(launch, "agent.yaml");
    writeFileSync(config, `agentId: probe\nworkspace: worktree\nmailDir: ${join(root, "mail")}\nmemoryPath: ${join(root, "memory.jsonl")}\nllm:\n  provider: ollama\n  model: probe\n`);
    symlinkSync(config, link);
    const childScript = `
      import { AgentRuntime } from ${JSON.stringify(runtimeModule)};
      import { runAgent } from ${JSON.stringify(agentModule)};
      AgentRuntime.prototype.start = async function () { console.log(this.config.workspace); };
      await runAgent({ action: 'start', config: ${JSON.stringify(realpathSync(link))}, sandboxed: true });
    `;
    const parentScript = `
      import { spawnSync } from 'node:child_process';
      import { loadAgentConfig } from ${JSON.stringify(configModule)};
      import { agentWorkspace } from ${JSON.stringify(workspaceModule)};
      const workspace = agentWorkspace(${JSON.stringify(link)}, loadAgentConfig(${JSON.stringify(link)}).workspace);
      console.log(workspace);
      const child = spawnSync('node', ['--input-type=module', '-e', ${JSON.stringify(childScript)}], {
        encoding: 'utf8', env: { ...process.env, TPS_AGENT_WORKSPACE: workspace },
      });
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      process.exit(child.status ?? 1);
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", parentScript], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: root }, timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const workspace = join(launch, "worktree");
    expect(result.stdout).toBe(`${workspace}\n${workspace}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const marker of ["matching", "different", "relative"] as const) {
  test(`real-file relative workspace child launch with ${marker} pending marker`, () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-launch-"));
    try {
      const home = join(root, "home");
      const base = join(home, "ops", "tps");
      const configDir = join(root, "config");
      const workspace = join(configDir, "worktree");
      mkdirSync(base, { recursive: true });
      mkdirSync(configDir);
      const git = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf8" });
      expect(git(["init", "-q"]).status).toBe(0);
      writeFileSync(join(base, "tracked.txt"), "checked out\n");
      expect(git(["add", "tracked.txt"]).status).toBe(0);
      expect(git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "init"]).status).toBe(0);
      const config = join(configDir, "agent.yaml");
      writeFileSync(config, "agentId: probe\nworkspace: worktree\n");
      const childScript = `
        import { readFileSync } from 'node:fs';
        import { loadAgentConfig } from ${JSON.stringify(configModule)};
        import { agentWorkspace } from ${JSON.stringify(workspaceModule)};
        import { checkoutWorktree } from ${JSON.stringify(lifecycleModule)};
        const config = loadAgentConfig(${JSON.stringify(config)});
        const workspace = agentWorkspace(${JSON.stringify(config)}, config.workspace, process.env);
        checkoutWorktree(workspace);
        console.log(workspace);
        console.log(readFileSync(workspace + '/tracked.txt', 'utf8'));
      `;
      const parentScript = `
        import { spawnSync } from 'node:child_process';
        import { loadAgentConfig } from ${JSON.stringify(configModule)};
        import { agentWorkspace } from ${JSON.stringify(workspaceModule)};
        import { onStart } from ${JSON.stringify(lifecycleModule)};
        const config = loadAgentConfig(${JSON.stringify(config)});
        const workspace = agentWorkspace(${JSON.stringify(config)}, config.workspace);
        const start = onStart('probe', workspace, { deferCheckout: true });
        if (!start.changed) throw new Error('worktree not created');
        const child = spawnSync('node', ['--input-type=module', '-e', ${JSON.stringify(childScript)}], {
          cwd: workspace, encoding: 'utf8',
          env: { ...process.env, TPS_AGENT_WORKSPACE: workspace,
            TPS_WORKTREE_PENDING: ${JSON.stringify(marker)} === 'matching' ? workspace : ${JSON.stringify(marker)} === 'different' ? workspace + '-other' : '../worktree' },
        });
        process.stdout.write(child.stdout);
        process.stderr.write(child.stderr);
        process.exit(child.status ?? 1);
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", parentScript], {
        cwd: root, encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 20_000,
      });
      if (marker === "matching") {
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`${workspace}\nchecked out\n\n`);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("WorktreeLifecycleError: pending worktree workspace mismatch");
        expect(result.stdout).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
