/**
 * cli#516 — sandboxed agent launch.
 *
 * Config and worktree launcher cases use fake nono to record argv; flag cases
 * invoke the built CLI directly. Real-nono cases skip when unavailable.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { resolve, join, dirname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolveNonoBinary } from "../src/utils/launch-attestation.js";
import {
  NONO_MIN_VERSION,
  canonicalPath,
  harnessReadFiles,
  agentLaunchOptions,
  buildNonoArgs,
  nonoVersion,
  runtimeNonoProfile,
  versionAtLeast,
} from "../src/utils/nono.js";
import { checkoutWorktree, onStart, onStop, WorktreeLifecycleError } from "../src/utils/agent-lifecycle.js";
import { realNonoHomeBase, sandboxHomeBase, NONO_PROBE_DENIED_PREFIX } from "./helpers/launcher-grants.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** The shipped CLI is a node script; the real-nono case must run it with node
 * (bun inside a nono sandbox sees an empty environment, so the launcher's
 * socket locator does not reach a bun child). */
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
async function stopRealLaunch(child: ReturnType<typeof spawn>, output: string): Promise<boolean> {
  const releasedPid = /released under nono session \S+ \(child pid (\d+)\)/.exec(output)?.[1];
  const targets = new Set<number>();
  if (releasedPid) targets.add(Number(releasedPid));
  else if (child.pid) targets.add(-child.pid);
  if (child.pid) targets.add(child.pid);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
      } catch {
        /* checked below */
      }
    }
    const deadline = Date.now() + 3_000;
    do {
      if ([...targets].every((pid) => !alive(pid))) return true;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);
  }
  return false;
}

const SANDBOX_REQUIRED = "--sandbox-required";
const NONO_BIN_ENV = "NONO_BIN";
const ACCEPTS_ONLY = "accepts only 'true' or 'false'";

setDefaultTimeout(30_000);

beforeAll(() => {
  if (!existsSync(TPS_BIN)) {
    throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
  }
});

/** Run the built launcher with piped stdio (stdin/stdout are NOT a TTY). */
function runLauncher(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  return spawnSync("bun", [TPS_BIN, ...args], {
    encoding: "utf-8",
    cwd: opts.cwd,
    timeout: 20_000,
    env: { ...process.env, ...opts.env },
  });
}

function output(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** A fake nono: answers the probe subcommands and logs `run` invocations. */
function fakeNonoScript(extra: string): string {
  return [
    "#!/usr/bin/env bash",
    'if [ "${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi',
    'if [ "${1:-}" = "profile" ]; then exit 0; fi',
    'if [ "${1:-}" = "why" ]; then echo \'{"status":"denied","reason":"path_not_granted"}\'; exit 0; fi',
    'if [ "${1:-}" = "run" ]; then',
    extra,
    '  echo "ARGV $*" >> "${NONO_ARGV_LOG:?}"',
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** ARGV lines the fake nono logged for a `run` (the launcher's spawn). */
function fakeNonoRuns(root: string): string[] {
  const log = join(root, "nono.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("ARGV run"))
    .map((l) => l.slice(5));
}

function writeProfilePair(profileDir: string, runProfile: string): void {
  writeFileSync(
    join(profileDir, "tps-base-fixture.json"),
    JSON.stringify({
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      meta: { name: "tps-base-fixture" },
      workdir: { access: "readwrite" },
      filesystem: { read: ["/usr", "/bin", "/lib", "/lib64"], deny: [] },
    }),
  );
  writeFileSync(
    join(profileDir, `${runProfile}.json`),
    JSON.stringify({
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      extends: "tps-base-fixture",
      meta: { name: runProfile },
    }),
  );
}

interface Sandbox {
  root: string;
  home: string;
  run: string;
  tmp: string;
  ws: string;
  nonoBin: string;
}

function makeSandbox(base: string = sandboxHomeBase()): Sandbox {
  // The base must sit outside every fixed launcher grant (cli#558): a HOME inside one
  // makes the launcher's runtime-options gate refuse before the case under test.
  const root = mkdtempSync(join(base, "tps-516-"));
  const home = join(root, "home");
  const run = join(root, "run");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  const nonoDir = join(root, "nono");
  for (const d of [
    home,
    run,
    tmp,
    ws,
    nonoDir,
    join(home, ".config", "nono", "profiles"),
    join(home, ".tps", "agents", "probe"),
    join(home, ".tps", "mail"),
    join(home, ".tps", "identity"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeProfilePair(join(home, ".config", "nono", "profiles"), "tps-agent-run");
  // Seed fixture identity files.
  writeFileSync(join(home, ".tps", "identity", "probe.key"), randomBytes(32));
  writeFileSync(
    join(home, ".tps", "identity", "probe.pub"),
    "fixture-pub\n",
  );
  return { root, home, run, tmp, ws, nonoBin: join(nonoDir, "nono") };
}

function agentYaml(sb: Sandbox, workspace: string): string {
  return (
    "agentId: probe\nname: probe\n" +
    `workspace: ${workspace}\n` +
    `mailDir: ${join(sb.home, ".tps", "mail")}\n` +
    `memoryPath: ${join(sb.home, ".tps", "agents", "probe", "memory.jsonl")}\n` +
    "llm:\n  provider: ollama\n  model: probe-model\n"
  );
}

function installFakeNono(sb: Sandbox, extra: string): void {
  writeFileSync(sb.nonoBin, fakeNonoScript(extra));
  chmodSync(sb.nonoBin, 0o755);
}

function cliEnv(sb: Sandbox, extra: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: sb.home,
    TMPDIR: sb.tmp,
    [NONO_BIN_ENV]: sb.nonoBin,
    NONO_ARGV_LOG: join(sb.root, "nono.log"),
    TPS_LAUNCH_TIMEOUT_MS: "1500",
    ...extra,
  };
}

for (const scenario of ["registered", "unregistered", "rewritten after setup", "no trusted base"] as const) {
  test(`additional Codex metadata directories use the setup registry binding: ${scenario}`, () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      const other = join(sb.root, "other");
      const g = (cwd: string, args: string[]) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      for (const repo of scenario === "no trusted base" ? [other] : [base, other]) {
        mkdirSync(repo, { recursive: true });
        g(repo, ["init", "-q"]);
        g(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
      }
      const registered = scenario === "registered" || scenario === "rewritten after setup";
      let expected: string[] = [];
      if (registered) {
        rmSync(sb.ws, { recursive: true });
        g(base, ["worktree", "add", "--detach", sb.ws]);
        expected = [g(sb.ws, ["rev-parse", "--absolute-git-dir"]), g(base, ["rev-parse", "--absolute-git-dir"])];
      } else {
        writeFileSync(join(sb.ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
      }
      installFakeNono(sb, "  :");
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws) + "workspaceProvider:\n  type: none\n");
      const attestationModule = resolve(import.meta.dir, "../dist/src/utils/launch-attestation.js");
      const agentModule = resolve(import.meta.dir, "../dist/src/commands/agent.js");
      const codexModule = resolve(import.meta.dir, "../dist/src/utils/codex-runtime.js");
      const preload = join(sb.root, "child-preload.ts");
      writeFileSync(preload, `
        import { mock } from 'bun:test';
        const attestation = await import(${JSON.stringify(attestationModule)});
        mock.module(${JSON.stringify(attestationModule)}, () => ({ ...attestation,
          attestConfinement: async () => ({ ok: true, worktreeBinding: JSON.parse(process.env.FIXTURE_BINDING) }),
        }));
        const codex = await import(${JSON.stringify(codexModule)});
        mock.module(${JSON.stringify(codexModule)}, () => ({ ...codex,
          runCodexRuntime: async (config) => console.log('CODEX_ARGS ' + JSON.stringify(codex.codexExecArgs(config))),
        }));
      `);
      const script = `
        import { mock } from 'bun:test';
        import { writeFileSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        const attestation = await import(${JSON.stringify(attestationModule)});
        mock.module(${JSON.stringify(attestationModule)}, () => ({ ...attestation,
          launchAttested: async (_profile, options, cmd, opts) => {
            console.log('SETUP_BINDING ' + JSON.stringify(opts.worktreeBinding));
            if (${JSON.stringify(scenario)} === 'rewritten after setup') {
              writeFileSync(${JSON.stringify(join(sb.ws, ".git"))}, ${JSON.stringify(`gitdir: ${join(other, ".git")}\n`)});
            }
            const child = spawnSync('bun', ['--preload', ${JSON.stringify(preload)}, ${JSON.stringify(TPS_BIN)}, ...cmd.slice(cmd.indexOf('agent'))], {
              encoding: 'utf8', cwd: ${JSON.stringify(sb.ws)},
              env: { ...opts.env, TPS_LAUNCH_SOCK: 'fixture', FIXTURE_BINDING: JSON.stringify(opts.worktreeBinding) },
            });
            process.stdout.write(child.stdout); process.stderr.write(child.stderr);
            return child.status ?? 1;
          },
        }));
        const { runAgent } = await import(${JSON.stringify(agentModule)});
        await runAgent({ action: 'start', id: 'probe', runtime: 'codex', sandboxRequired: true });
      `;
      const result = spawnSync("bun", ["-e", script], {
        cwd: sb.run, encoding: "utf8", timeout: 20_000, env: cliEnv(sb),
      });
      expect(result.status, output(result)).toBe(0);
      const bindingLine = result.stdout.split("\n").find((line) => line.startsWith("SETUP_BINDING "));
      expect(bindingLine, output(result)).toBeDefined();
      const binding = JSON.parse(bindingLine!.slice("SETUP_BINDING ".length));
      expect(binding.kind).toBe(registered ? "registered" : scenario === "unregistered" ? "unregistered" : "none");
      if (registered) expect([binding.gitDir, binding.gitCommonDir]).toEqual(expected);
      const argsLine = result.stdout.split("\n").find((line) => line.startsWith("CODEX_ARGS "));
      expect(argsLine, output(result)).toBeDefined();
      const args: string[] = JSON.parse(argsLine!.slice("CODEX_ARGS ".length));
      const addDirs = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]!] : []);
      expect(addDirs).toEqual([
        join(sb.home, ".tps", "mail", "probe"), join(sb.home, "ops", "tps"), join(sb.home, "ops", "flair"), ...expected,
      ]);
      expect(addDirs).not.toContain(join(other, ".git"));
      if (scenario === "rewritten after setup") {
        expect(readFileSync(join(sb.ws, ".git"), "utf8")).toBe(`gitdir: ${join(other, ".git")}\n`);
      }
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// (1) — `--config` survives the attested re-exec
// ---------------------------------------------------------------------------

describe("cli#516 (1) — the attested re-exec uses a config snapshot", () => {
  test("agent start re-execs with the config snapshot and grants its file", () => {
    const sb = makeSandbox();
    try {
      installFakeNono(sb, "  :");
      // The default config lives in the agent dir; the custom one, elsewhere.
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws),
      );
      const customDir = join(sb.root, "custom");
      const customConfig = join(customDir, "agent.yaml");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(customConfig, agentYaml(sb, sb.ws));

      const result = runLauncher(
        ["agent", "start", "--config", customConfig, SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb) },
      );

      const child = fakeNonoRuns(sb.root).find((l) => l.includes("agent start")) ?? "";
      const snapshot = /--config (\S+)/.exec(child)?.[1];
      expect(snapshot, output(result)).toBeDefined();
      expect(snapshot).toStartWith(join(sb.home, ".tps", "launch", "config-"));
      expect(child, output(result)).toContain(`--config ${snapshot}`);
      expect(child).toContain(`--read-file ${snapshot}`);
      expect(child).not.toContain(`--read-file ${customConfig}`);
      expect(existsSync(snapshot!)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a relative --config is carried as an absolute snapshot path", () => {
    const sb = makeSandbox();
    try {
      installFakeNono(sb, "  :");
      // The config sits at a RELATIVE path from the launch cwd (`sb.run`), and
      // its workspace is neither the cwd nor the config's directory.
      const customDir = join(sb.run, "rel");
      mkdirSync(customDir, { recursive: true });
      const customAbs = join(customDir, "agent.yaml");
      writeFileSync(customAbs, agentYaml(sb, sb.ws));

      runLauncher(
        ["agent", "start", "--config", join("rel", "agent.yaml"), SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb) },
      );

      const child = fakeNonoRuns(sb.root).find((l) => l.includes("agent start")) ?? "";
      const snapshot = /--config (\S+)/.exec(child)?.[1];
      expect(snapshot).toBeDefined();
      expect(snapshot).toStartWith(join(sb.home, ".tps", "launch", "config-"));
      expect(child).toContain(`--config ${snapshot}`);
      expect(child).toContain(`--read-file ${snapshot}`);
      expect(child).not.toContain(`--read-file ${customAbs}`);
      expect(existsSync(snapshot!)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

test.each(["../ws", "nested/worktree"])("config snapshot, child and workspace grant resolve %s against the original config directory", (configuredWorkspace) => {
  const sb = makeSandbox();
  try {
    const workspace = resolve(sb.run, configuredWorkspace);
    mkdirSync(workspace, { recursive: true });
    const target = join(sb.run, "agent.yaml");
    const alternate = join(sb.root, "alternate.yaml");
    const link = join(sb.run, "config.yaml");
    writeFileSync(target, agentYaml(sb, configuredWorkspace));
    writeFileSync(alternate, agentYaml(sb, sb.run));
    symlinkSync(target, link);
    installFakeNono(sb, "  :");
    const attestationModule = resolve(import.meta.dir, "../dist/src/utils/launch-attestation.js");
    const agentModule = resolve(import.meta.dir, "../dist/src/commands/agent.js");
    const loader = `
      const agent = await import(${JSON.stringify(resolve(import.meta.dir, "../../agent/dist/index.js"))});
      const load = agent.loadAgentConfig;
      mock.module(${JSON.stringify(resolve(import.meta.dir, "../../agent/dist/index.js"))}, () => ({ ...agent,
        AgentRuntime: class {
          constructor(config) { this.config = config; }
          async start() { console.log('WORKSPACE ' + this.config.workspace); }
        },
        loadAgentConfig: (path) => {
          const config = load(path);
          console.log('PARSED ' + JSON.stringify({ path, workspace: config.workspace }));
          return config;
        },
      }));
    `;
    const preload = join(sb.root, "snapshot-child.ts");
    writeFileSync(preload, `
      import { mock } from 'bun:test';
      ${loader}
      const attestation = await import(${JSON.stringify(attestationModule)});
      mock.module(${JSON.stringify(attestationModule)}, () => ({ ...attestation,
        attestConfinement: async () => ({ ok: true, worktreeBinding: { kind: 'none' } }),
      }));
    `);
    const result = spawnSync("bun", ["-e", `
      import { mock } from 'bun:test';
      import { readFileSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { spawnSync } from 'node:child_process';
      ${loader}
      const attestation = await import(${JSON.stringify(attestationModule)});
      mock.module(${JSON.stringify(attestationModule)}, () => ({ ...attestation,
        launchAttested: async (_profile, options, cmd, opts) => {
          const path = cmd[cmd.indexOf('--config') + 1];
          console.log('LAUNCH ' + JSON.stringify({ options, cmd, path,
            content: readFileSync(path, 'utf8'),
            fileMode: statSync(path).mode & 0o777, dirMode: statSync(dirname(path)).mode & 0o777,
            owner: statSync(dirname(path)).uid, uid: process.getuid(),
          }));
          const child = spawnSync('bun', ['--preload', ${JSON.stringify(preload)}, ${JSON.stringify(TPS_BIN)}, ...cmd.slice(cmd.indexOf('agent'))], {
            encoding: 'utf8', cwd: options.cwd ?? process.cwd(), env: { ...opts.env, TPS_AGENT_WORKSPACE: undefined, TPS_LAUNCH_SOCK: 'fixture' },
          });
          process.stdout.write(child.stdout); process.stderr.write(child.stderr);
          return child.status ?? 1;
        },
      }));
      const { runAgent } = await import(${JSON.stringify(agentModule)});
      await runAgent({ action: 'start', id: 'probe', config: ${JSON.stringify(link)}, sandboxRequired: true }, {
        afterConfigSnapshot: (path) => {
          unlinkSync(${JSON.stringify(link)});
          symlinkSync(${JSON.stringify(alternate)}, ${JSON.stringify(link)});
          console.log('SNAPSHOT ' + path);
        },
      });
    `], { cwd: sb.run, encoding: "utf8", timeout: 20_000, env: cliEnv(sb) });
    expect(result.status, output(result)).toBe(0);
    const lines = result.stdout.split("\n");
    const snapshot = lines.find((line) => line.startsWith("SNAPSHOT "))?.slice(9);
    expect(snapshot, output(result)).toBeDefined();
    const parsed = lines.filter((line) => line.startsWith("PARSED ")).map((line) => JSON.parse(line.slice(7)));
    expect(parsed).toEqual([{ path: snapshot, workspace: configuredWorkspace }, { path: snapshot, workspace }]);
    const launch = JSON.parse(lines.find((line) => line.startsWith("LAUNCH "))!.slice(7));
    expect(launch.path).toBe(snapshot);
    expect(launch.options.workdir).toBe(canonicalPath(workspace));
    expect(launch.content).toBe(agentYaml(sb, workspace));
    expect(launch.options.allow).toContain(canonicalPath(workspace));
    expect(launch.options.allow).not.toContain(resolve(dirname(snapshot!), configuredWorkspace));
    expect(launch.fileMode).toBe(0o600);
    expect(launch.dirMode).toBe(0o700);
    expect(launch.owner).toBe(launch.uid);
    expect(launch.options.readFiles).toEqual([...harnessReadFiles("probe", sb.home).map((path) => canonicalPath(path)), snapshot]);
    for (const path of [launch.options.cwd ?? sb.run, launch.options.workdir, ...launch.options.allow].filter(Boolean)) {
      expect(snapshot === path || snapshot!.startsWith(`${path}/`)).toBe(false);
    }
    expect(launch.options.readFiles).not.toContain(target);
    expect(launch.options.readFiles).not.toContain(alternate);
    expect(launch.options.readFiles).not.toContain(link);
    const grants = buildNonoArgs("tps-agent-run", launch.options, launch.cmd);
    expect(grants).toContain(snapshot!);
    expect(grants).not.toContain(target);
    expect(grants).not.toContain(alternate);
    expect(grants).not.toContain(link);
    expect(lines).toContain(`WORKSPACE ${workspace}`);
    expect(existsSync(snapshot!)).toBe(false);
    expect(existsSync(dirname(snapshot!))).toBe(false);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("the parent removes its config snapshot on SIGTERM", () => {
  const sb = makeSandbox();
  try {
    const config = join(sb.run, "agent.yaml");
    writeFileSync(config, agentYaml(sb, sb.ws));
    installFakeNono(sb, "  :");
    const agentModule = resolve(import.meta.dir, "../dist/src/commands/agent.js");
    const attestationModule = resolve(import.meta.dir, "../dist/src/utils/launch-attestation.js");
    const result = spawnSync("bun", ["-e", `
      import { mock } from 'bun:test';
      const attestation = await import(${JSON.stringify(attestationModule)});
      mock.module(${JSON.stringify(attestationModule)}, () => ({ ...attestation,
        launchAttested: async () => {
          process.kill(process.pid, 'SIGTERM');
          await new Promise(() => {});
        },
      }));
      const { runAgent } = await import(${JSON.stringify(agentModule)});
      await runAgent({ action: 'start', config: ${JSON.stringify(config)}, sandboxRequired: true }, {
        afterConfigSnapshot: (path) => console.log('SNAPSHOT ' + path),
      });
    `], { cwd: sb.run, encoding: "utf8", timeout: 20_000, env: cliEnv(sb) });
    expect(result.signal, output(result)).toBe("SIGTERM");
    const snapshot = result.stdout.split("\n").find((line) => line.startsWith("SNAPSHOT "))?.slice(9);
    expect(snapshot).toBeDefined();
    expect(existsSync(snapshot!)).toBe(false);
    expect(existsSync(dirname(snapshot!))).toBe(false);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (2) — worktree setup runs before the sandbox; a git operation failure is a
// named error (a workspace with no base repository is a no-op, not a failure)
// ---------------------------------------------------------------------------

describe("cli#516 (2) — sandboxed launch defers worktree checkout", () => {
  test("the managed worktree exists before the sandbox is entered", () => {
    const sb = makeSandbox();
    try {
      // The base repo sits at the default ~/ops/tps; the workspace is its
      // worktree and must NOT exist yet, so setup has real work to do.
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "README.md"]);
      g(["commit", "-qm", "init"]);
      rmSync(sb.ws, { recursive: true, force: true });

      installFakeNono(
        sb,
        `  if [ -d "\${WORKTREE_WS:?}" ]; then echo "WORKTREE_AT_SANDBOX_START=yes" >> "\${NONO_ARGV_LOG:?}"; else echo "WORKTREE_AT_SANDBOX_START=no" >> "\${NONO_ARGV_LOG:?}"; fi`,
      );
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );

      runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb, { WORKTREE_WS: sb.ws }) },
      );

      const log = existsSync(join(sb.root, "nono.log"))
        ? readFileSync(join(sb.root, "nono.log"), "utf-8")
        : "";
      expect(log).toContain("WORKTREE_AT_SANDBOX_START=yes");
      // Cleanup ran after the sandbox: the worktree is gone again.
      expect(existsSync(sb.ws)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  for (const dangling of [false, true]) {
    test(dangling ? "a dangling base symlink stops launch before nono" : "a valid base symlink launches with resolved grants", () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.home, "ops", "tps");
        const target = join(sb.root, "projects", "repo");
        mkdirSync(dirname(base), { recursive: true });
        if (!dangling) {
          mkdirSync(target, { recursive: true });
          for (const args of [["init", "-q"], ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]]) {
            expect(spawnSync("git", args, { cwd: target }).status).toBe(0);
          }
        }
        symlinkSync(target, base);
        rmSync(sb.ws, { recursive: true });
        installFakeNono(sb, "  :");
        writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
        writeFileSync(join(sb.home, ".tps", "agents", "probe", "agent.yaml"), agentYaml(sb, sb.ws));
        const result = runLauncher(
          ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
          { cwd: sb.run, env: cliEnv(sb) },
        );
        if (dangling) {
          expect(output(result)).toContain("git probe failed for the base repository");
          expect(fakeNonoRuns(sb.root)).toEqual([]);
        } else {
          expect(fakeNonoRuns(sb.root).length, output(result)).toBeGreaterThan(0);
          expect(fakeNonoRuns(sb.root).join("\n")).toContain(`--read ${target}/.git`);
          expect(fakeNonoRuns(sb.root).join("\n")).not.toContain(`--read ${base}/.git`);
        }
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  test("a blocked workspace parent stops launch before the sandbox", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "README.md"]);
      g(["commit", "-qm", "init"]);
      const blocker = join(sb.root, "blocker");
      writeFileSync(blocker, "not a directory\n");
      const blockedWs = join(blocker, "ws");

      installFakeNono(sb, "  :");
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, blockedWs).replace("provider: ollama", "provider: openai"),
      );

      const r = runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb) },
      );
      expect(output(r)).toContain("worktree marker probe failed");
      expect(fakeNonoRuns(sb.root)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a metadata failure after worktree creation removes the worktree", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const gitBin = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const g = (args: string[]) => spawnSync(gitBin, args, { cwd: base, encoding: "utf8" });
      expect(g(["init", "-q"]).status).toBe(0);
      expect(g(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]).status).toBe(0);
      rmSync(sb.ws, { recursive: true });
      const bin = join(sb.root, "bin");
      mkdirSync(bin);
      const wrapper = join(bin, "git");
      writeFileSync(wrapper, [
        "#!/bin/sh",
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then echo "injected metadata failure" >&2; exit 79; fi',
        `exec "${gitBin}" "$@"`,
        "",
      ].join("\n"));
      chmodSync(wrapper, 0o755);
      installFakeNono(sb, "  :");
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(join(sb.home, ".tps", "agents", "probe", "agent.yaml"), agentYaml(sb, sb.ws));
      const result = runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb, { PATH: `${bin}:${process.env.PATH}` }) },
      );
      expect(output(result)).toContain("injected metadata failure");
      expect(fakeNonoRuns(sb.root)).toEqual([]);
      expect(existsSync(sb.ws)).toBe(false);
      expect(g(["worktree", "list", "--porcelain"]).stdout).not.toContain(sb.ws);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a post-checkout hook in the base repository never runs during parent-side setup", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "README.md"]);
      g(["commit", "-qm", "init"]);
      rmSync(sb.ws, { recursive: true, force: true });
      // A marker post-checkout hook: if git runs it, the file appears.
      const marker = join(sb.root, "hook-ran");
      const hook = join(base, ".git", "hooks", "post-checkout");
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(hook, 0o755);

      installFakeNono(
        sb,
        `  if [ -d "\${WORKTREE_WS:?}" ]; then echo "WORKTREE_AT_SANDBOX_START=yes" >> "\${NONO_ARGV_LOG:?}"; else echo "WORKTREE_AT_SANDBOX_START=no" >> "\${NONO_ARGV_LOG:?}"; fi`,
      );
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );

      runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb, { WORKTREE_WS: sb.ws }) },
      );

      // Setup registered the worktree without checkout.
      const log = existsSync(join(sb.root, "nono.log"))
        ? readFileSync(join(sb.root, "nono.log"), "utf-8")
        : "";
      expect(log).toContain("WORKTREE_AT_SANDBOX_START=yes");

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a smudge filter and an fsmonitor hook from the base repository do not run during parent-side setup", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      // The locally configured commands each write a marker when run.
      const smudgeMarker = join(sb.root, "smudge-ran");
      const fsmonitorMarker = join(sb.root, "fsmonitor-ran");
      const smudge = join(sb.root, "smudge.sh");
      writeFileSync(smudge, `#!/bin/sh\ntouch "${smudgeMarker}"\ncat\n`);
      chmodSync(smudge, 0o755);
      const fsmonitor = join(sb.root, "fsmonitor.sh");
      writeFileSync(fsmonitor, `#!/bin/sh\ntouch "${fsmonitorMarker}"\necho\nexit 0\n`);
      chmodSync(fsmonitor, 0o755);
      g(["config", "filter.marker.smudge", smudge]);
      g(["config", "core.fsmonitor", fsmonitor]);
      writeFileSync(join(base, ".gitattributes"), "* filter=marker\n");
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      rmSync(sb.ws, { recursive: true, force: true });
      // Clear markers before measuring the launch.
      rmSync(smudgeMarker, { force: true });
      rmSync(fsmonitorMarker, { force: true });

      installFakeNono(
        sb,
        `  if [ -e "\${WORKTREE_WS:?}/README.md" ]; then echo "WORKTREE_CHECKED_OUT=yes" >> "\${NONO_ARGV_LOG:?}"; else echo "WORKTREE_CHECKED_OUT=no" >> "\${NONO_ARGV_LOG:?}"; fi`,
      );
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );

      runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb, { WORKTREE_WS: sb.ws }) },
      );

      const log = existsSync(join(sb.root, "nono.log"))
        ? readFileSync(join(sb.root, "nono.log"), "utf-8")
        : "";
      // The parent registered the worktree but left it UNCHECKED OUT, so the
      // checkout (and with it any filter or hook) is still to come, inside the
      // sandbox…
      expect(log).toContain("WORKTREE_CHECKED_OUT=no");
      // …and neither marker-writing executable ran in the parent.
      expect(existsSync(smudgeMarker)).toBe(false);
      expect(existsSync(fsmonitorMarker)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a child registry rewrite makes parent cleanup fail", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf8" });
      expect(g(["init", "-q"]).status).toBe(0);
      expect(g(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]).status).toBe(0);
      rmSync(sb.ws, { recursive: true });
      installFakeNono(sb, `  printf '%s/repointed/.git\\n' "\${BASE_REPO:?}" > "\${BASE_REPO:?}/.git/worktrees/ws/gitdir"`);
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(join(sb.home, ".tps", "agents", "probe", "agent.yaml"), agentYaml(sb, sb.ws));
      const attestationModule = resolve(import.meta.dir, "../dist/src/utils/launch-attestation.js");
      const agentModule = resolve(import.meta.dir, "../dist/src/commands/agent.js");
      const script = `
        import { mock } from 'bun:test';
        import { spawnSync } from 'node:child_process';
        const attestation = await import(${JSON.stringify(attestationModule)});
        mock.module(${JSON.stringify(attestationModule)}, () => ({
          ...attestation,
          launchAttested: async () => {
            const child = spawnSync(process.env.NONO_BIN, ['run'], { env: process.env, encoding: 'utf8' });
            if (child.status !== 0) throw new Error(child.stderr);
            return 0;
          },
        }));
        const { runAgent } = await import(${JSON.stringify(agentModule)});
        await runAgent({ action: 'start', id: 'probe', runtime: 'codex', sandboxRequired: true });
      `;
      const result = spawnSync("bun", ["-e", script], {
        cwd: sb.run, encoding: "utf8", timeout: 20_000,
        env: cliEnv(sb, { BASE_REPO: base }),
      });
      expect(result.status, output(result)).not.toBe(0);
      expect(output(result)).toContain(`worktree cleanup binding changed for ${sb.ws}`);
      expect(fakeNonoRuns(sb.root).length).toBeGreaterThan(0);
      expect(readFileSync(join(base, ".git", "worktrees", "ws", "gitdir"), "utf8")).toBe(`${base}/repointed/.git\n`);
      expect(existsSync(sb.ws)).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an existing worktree survives the launch", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "README.md"]);
      g(["commit", "-qm", "init"]);
      // An EXISTING worktree this launch did not create.
      rmSync(sb.ws, { recursive: true, force: true });
      g(["worktree", "add", sb.ws, "--detach"]);

      installFakeNono(sb, "  :");
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );

      runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb) },
      );

      // Still present and still registered: cleanup skipped it.
      expect(readFileSync(join(sb.ws, "README.md"), "utf-8")).toBe("# base\n");
      const listed = g(["worktree", "list", "--porcelain"]).stdout;
      expect(listed).toContain(sb.ws);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an inherited TPS_WORKTREE_PENDING does not check an existing worktree out", () => {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      g(["init", "-q"]);
      g(["config", "user.email", "agent-a@tps.dev"]);
      g(["config", "user.name", "agent-a"]);
      writeFileSync(join(base, "README.md"), "# base\n");
      g(["add", "README.md"]);
      g(["commit", "-qm", "init"]);
      // An EXISTING branch worktree this launch did not create.
      g(["branch", "feature"]);
      rmSync(sb.ws, { recursive: true, force: true });
      g(["worktree", "add", sb.ws, "feature"]);

      // The child checks the worktree out only when it inherits this marker
      // (bin/tps.ts). Record the child's environment: it must not carry the
      // marker, because this launch created no worktree.
      installFakeNono(
        sb,
        `  if [ -n "\${TPS_WORKTREE_PENDING:-}" ]; then echo "CHILD_MARKER=$TPS_WORKTREE_PENDING" >> "\${NONO_ARGV_LOG:?}"; else echo "CHILD_MARKER=absent" >> "\${NONO_ARGV_LOG:?}"; fi`,
      );
      writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );

      runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb, { TPS_WORKTREE_PENDING: sb.ws }) },
      );

      const log = existsSync(join(sb.root, "nono.log"))
        ? readFileSync(join(sb.root, "nono.log"), "utf-8")
        : "";
      expect(log).toContain("CHILD_MARKER=absent");
      // The worktree survived and is still on its branch.
      expect(readFileSync(join(sb.ws, "README.md"), "utf-8")).toBe("# base\n");
      const head = spawnSync("git", ["-C", sb.ws, "symbolic-ref", "-q", "HEAD"], {
        encoding: "utf-8",
      });
      expect(head.stdout.trim()).toBe("refs/heads/feature");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  for (const kind of ["absent", "plain", "file", "path-link", "marker-link", "marker-dangling"] as const) {
    test(`setup and cleanup classify a ${kind} base candidate consistently`, () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.root, "tps");
        mkdirSync(dirname(base), { recursive: true });
        if (kind === "file") writeFileSync(base, "fixture");
        else if (kind === "path-link") symlinkSync(join(sb.root, "missing"), base);
        else if (kind !== "absent") {
          mkdirSync(base);
          if (kind.startsWith("marker-")) {
            const target = join(sb.root, "metadata");
            if (kind === "marker-link") {
              expect(spawnSync("git", ["init", "--bare", target]).status).toBe(0);
            }
            symlinkSync(target, join(base, ".git"));
          }
        }
        for (const operation of [onStart, onStop]) {
          if (kind === "absent" || kind === "plain") {
            expect(operation("probe", sb.ws).changed).toBe(false);
          } else {
            expect(() => operation("probe", sb.ws)).toThrow(WorktreeLifecycleError);
          }
        }
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const metadata of ["config", "gitdir"] as const) {
    test(`setup and cleanup reject unresolvable base ${metadata} metadata with real Git`, () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.root, "tps");
        mkdirSync(base);
        const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
        expect(g(["init", "-q"]).status).toBe(0);
        expect(g(["rev-parse", "--is-inside-work-tree"]).stdout.trim()).toBe("true");
        if (metadata === "config") {
          writeFileSync(join(base, ".git", "config"), "this is not a git config\n");
        } else {
          rmSync(join(base, ".git"), { recursive: true });
          writeFileSync(join(base, ".git"), `gitdir: ${join(base, "missing-gitdir")}\n`);
        }
        expect(g(["rev-parse", "--is-inside-work-tree"]).status).not.toBe(0);
        for (const operation of [onStart, onStop]) {
          expect(() => operation("probe", sb.ws)).toThrow(WorktreeLifecycleError);
        }
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const metadata of ["config", "gitdir"] as const) {
    test(`unresolvable base ${metadata} metadata stops setup before nono starts`, () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.home, "ops", "tps");
        mkdirSync(base, { recursive: true });
        const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
        expect(g(["init", "-q"]).status).toBe(0);
        expect(g(["config", "user.email", "agent-a@tps.dev"]).status).toBe(0);
        expect(g(["config", "user.name", "agent-a"]).status).toBe(0);
        writeFileSync(join(base, "README.md"), "# base\n");
        expect(g(["add", "README.md"]).status).toBe(0);
        expect(g(["commit", "-qm", "init"]).status).toBe(0);
        rmSync(sb.ws, { recursive: true, force: true });
        if (metadata === "config") {
          writeFileSync(join(base, ".git", "config"), "this is not a git config\n");
        } else {
          rmSync(join(base, ".git"), { recursive: true });
          writeFileSync(join(base, ".git"), `gitdir: ${join(base, "missing-gitdir")}\n`);
          expect(g(["rev-parse", "--is-inside-work-tree"]).status).not.toBe(0);
        }

        installFakeNono(sb, "  :");
        writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
        writeFileSync(
          join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
          agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
        );

        const r = runLauncher(
          ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
          { cwd: sb.run, env: cliEnv(sb) },
        );

        expect(output(r)).toContain("git probe failed");
        // The failure is reported instead of proceeding, and nono never starts.
        expect(fakeNonoRuns(sb.root)).toEqual([]);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });

    test(`unresolvable base ${metadata} metadata reports a cleanup failure`, () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.home, "ops", "tps");
        mkdirSync(base, { recursive: true });
        const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
        expect(g(["init", "-q"]).status).toBe(0);
        expect(g(["config", "user.email", "agent-a@tps.dev"]).status).toBe(0);
        expect(g(["config", "user.name", "agent-a"]).status).toBe(0);
        writeFileSync(join(base, "README.md"), "# base\n");
        expect(g(["add", "README.md"]).status).toBe(0);
        expect(g(["commit", "-qm", "init"]).status).toBe(0);
        rmSync(sb.ws, { recursive: true, force: true });

        installFakeNono(sb, metadata === "config"
          ? `  printf 'this is not a git config\\n' > "\${BASE_REPO:?}/.git/config"`
          : `  mv "\${BASE_REPO:?}/.git" "\${BASE_REPO:?}/saved-git"
    printf 'gitdir: %s/missing-gitdir\\n' "\${BASE_REPO:?}" > "\${BASE_REPO:?}/.git"`);
        writeProfilePair(join(sb.home, ".config", "nono", "profiles"), "tps-agent-run-codex");
        writeFileSync(
          join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
          agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
        );

        const r = runLauncher(
          ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
          { cwd: sb.run, env: cliEnv(sb, { BASE_REPO: base }) },
        );

        expect(output(r)).toContain("git probe failed");
        expect(fakeNonoRuns(sb.root).length).toBeGreaterThan(0);
        expect(g(["rev-parse", "--is-inside-work-tree"]).status).not.toBe(0);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  test("cleanup reports a workspace probe failure, not absence, when the path cannot be probed", () => {
    const sb = makeSandbox();
    try {
      // A child process is given a HOME whose base repository resolves, so the
      // workspace probe is the one that runs. The workspace's parent is a
      // regular file, so lstat on the workspace fails with ENOTDIR on every uid
      // (root included), where existsSync reports false.
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const g = (args: string[]) => spawnSync("git", args, { cwd: base, encoding: "utf-8" });
      expect(g(["init", "-q"]).status).toBe(0);
      const blocker = join(sb.root, "not-a-dir");
      writeFileSync(blocker, "fixture\n");
      const ws = join(blocker, "ws");

      const mod = resolve(import.meta.dir, "../src/utils/agent-lifecycle.js");
      const script =
        `import(${JSON.stringify(mod)}).then((m) => {` +
        ` try { m.onStop("probe", ${JSON.stringify(ws)}); console.log("NO-THROW"); }` +
        ` catch (err) { console.log("THREW:" + err.name); } });`;
      const r = spawnSync("bun", ["-e", script], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, HOME: sb.home },
      });
      expect(output(r)).toContain("THREW:WorktreeLifecycleError");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (3) — the sandbox-flag scan reads the arguments before a wrapped payload
// ---------------------------------------------------------------------------

describe("cli#516 (3) — --sandbox/--sandboxed inside a message or wrapped command is not a flag", () => {
  test("a message body containing --sandbox <word> is not refused as a flag", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(
        ["agent", "run", "--id", "ghost", "--message", "build", "--sandbox", "now"],
        { cwd: sb.run, env: { ...process.env, HOME: sb.home } },
      );
      expect(output(r)).not.toContain(ACCEPTS_ONLY);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a wrapped command containing --sandbox <word> is not refused as a flag", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(["secrets-guard", "printf", "--sandbox", "now"], {
        cwd: sb.run,
        env: { ...process.env, HOME: sb.home },
      });
      expect(output(r)).not.toContain(ACCEPTS_ONLY);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an invalid --sandbox value tps itself owns is still refused by name", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(
        ["agent", "start", "--runtime", "codex", "--sandbox", "1", "--no-sandbox"],
        { cwd: sb.run, env: { ...process.env, HOME: sb.home } },
      );
      expect(output(r)).toContain("--sandbox accepts only 'true' or 'false'");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a message payload containing --sandboxed is not refused as a launcher claim", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(
        ["agent", "run", "--id", "ghost", "--message", "hi", "--sandboxed"],
        { cwd: sb.run, env: { ...process.env, HOME: sb.home } },
      );
      expect(output(r)).not.toContain("no launcher released this process");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a wrapped command containing --sandboxed is not refused as a launcher claim", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(["secrets-guard", "printf", "hi", "--sandboxed"], {
        cwd: sb.run,
        env: { ...process.env, HOME: sb.home },
      });
      expect(output(r)).not.toContain("no launcher released this process");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  for (const payload of [true, false]) {
    test(`codex start --sandbox-required requires confinement (payload=${payload})`, () => {
      const sb = makeSandbox();
      try {
        const config = join(sb.home, ".tps", "agents", "probe", "agent.yaml");
        writeFileSync(config, agentYaml(sb, sb.ws));
        const r = runLauncher([
          "agent", "start", "--id", "probe", "--runtime", "codex",
          "--config", config, SANDBOX_REQUIRED,
          ...(payload ? ["--", "--sandboxed"] : ["--sandboxed"]),
        ], {
          cwd: sb.run,
          env: cliEnv(sb, { TPS_LAUNCH_SOCK: undefined }),
        });
        expect(r.status, output(r)).toBe(78);
        expect(output(r)).toContain(payload
          ? "refusing to launch runtime 'codex': no nono at the pinned absolute path"
          : "--sandboxed is refused: no launcher released this process");
        expect(fakeNonoRuns(sb.root)).toEqual([]);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const flag of ["absent", "payload", "own"] as const) {
    test(`attestation requires an own --sandboxed argument (${flag})`, () => {
      const own = flag === "own";
      const sb = makeSandbox();
      try {
        const attempts = join(sb.root, "attestation-attempts");
        const preload = join(sb.root, "observe-connect.mjs");
        writeFileSync(preload, [
          'import { Socket } from "node:net";',
          'import { appendFileSync } from "node:fs";',
          'const connect = Socket.prototype.connect;',
          'Socket.prototype.connect = function (...args) {',
          `  appendFileSync(${JSON.stringify(attempts)}, "connect\\n");`,
          '  return connect.apply(this, args);',
          '};',
        ].join("\n"));
        const result = spawnSync(NODE, ["--import", preload, TPS_BIN,
          ...(own ? ["agent", "start", "--sandboxed"] : ["agent", "run", "--id", "ghost", "--message", "hi", ...(flag === "payload" ? ["--", "--sandboxed"] : [])]),
        ], {
          encoding: "utf8", cwd: sb.run, timeout: 20_000,
          env: cliEnv(sb, { TPS_LAUNCH_SOCK: join(sb.root, "inherited.sock") }),
        });
        expect(result.error).toBeUndefined();
        expect(existsSync(attempts), output(result)).toBe(own);
        if (own) expect(output(result)).toContain("--sandboxed is refused: no launcher released this process");
        else expect(output(result)).not.toContain("no launcher released this process");
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  test("an actual, unattested --sandboxed flag is still refused", () => {
    const sb = makeSandbox();
    try {
      const r = runLauncher(["agent", "start", "--sandboxed"], {
        cwd: sb.run,
        env: { ...process.env, HOME: sb.home },
      });
      expect(output(r)).toContain("no launcher released this process");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real nono, where reachable by an absolute path
// ---------------------------------------------------------------------------

const resolvedNono = resolveNonoBinary();
const resolvedNonoVersion = resolvedNono.bin ? nonoVersion(resolvedNono.bin) : null;
const realNono =
  resolvedNono.bin && resolvedNonoVersion && versionAtLeast(resolvedNonoVersion, NONO_MIN_VERSION)
    ? resolvedNono.bin
    : null;
const realNonoSkip = !resolvedNono.bin
  ? `no nono at an absolute path (${resolvedNono.reason ?? "unknown"})`
  : `nono ${resolvedNonoVersion ?? "unknown"} at ${resolvedNono.bin} is below the ${NONO_MIN_VERSION} floor`;

// The Docker lane mounts the pinned nono at the pinned location
// (DEFAULT_NONO_PATHS); the fixture grants the toolchain, the repo checkout and
// the running interpreter, and HOME/.bun.
const SYSTEM_READ = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/opt/homebrew", "/private/etc/ssl"];

function seedRealNonoProfiles(home: string): void {
  const profileDir = join(home, ".config", "nono", "profiles");
  mkdirSync(profileDir, { recursive: true });
  // The monorepo root (packages/cli/test -> the checkout), where the hoisted
  // node_modules the CLI resolves its dependencies from lives.
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  // On macOS, the checkout, interpreter and ~/.bun roots are granted as exact
  // directories rather than their ancestors (the fixed SYSTEM_READ roots are
  // ancestor grants by design): a read grant is recursive, so an ancestor of
  // the checkout or interpreter reaches every sibling of it. With bun under
  // ~/.bun that would be /Users and the operator's whole home, the fixture
  // HOME's base among them, which the launcher then (correctly) refuses. Under
  // macOS Seatbelt, node and bun run a script and a binary below an exact grant
  // without one (measured). On the Linux Docker lane /usr is granted and is an
  // ancestor of the interpreter's directory; that lane's grants are otherwise
  // unchanged: /app has no ancestor below /, and the oven/bun image's
  // /usr/local/bin already sits under /usr.
  const read = [
    ...new Set([
      ...SYSTEM_READ,
      join(home, ".bun"),
      repoRoot,
      dirname(process.execPath),
    ]),
  ];
  writeFileSync(
    join(profileDir, "tps-base-fixture.json"),
    JSON.stringify({
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      meta: { name: "tps-base-fixture" },
      workdir: { access: "readwrite" },
      filesystem: { read, deny: [] },
    }),
  );
  writeFileSync(
    join(profileDir, "tps-agent-run.json"),
    JSON.stringify({
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      extends: "tps-base-fixture",
      meta: { name: "tps-agent-run" },
      workdir: { access: "readwrite" },
    }),
  );
  writeFileSync(
    join(profileDir, "tps-agent-run-codex.json"),
    JSON.stringify({
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      extends: "tps-base-fixture",
      meta: { name: "tps-agent-run-codex" },
      workdir: { access: "readwrite" },
    }),
  );
}

/** Read a file, reporting absence with false rather than a stat-then-read pair. */
function canRead(path: string): boolean {
  try {
    readFileSync(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Wait (bounded) until `predicate` is true, or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return predicate();
}

let realNonoBase: string | undefined;
function makeRealNonoSandbox(): Sandbox {
  realNonoBase ??= realNonoHomeBase(realNono as string);
  return makeSandbox(realNonoBase);
}

/** Wait (bounded) for `predicate`, giving up early once the launcher exits. */
function waitWhileRunning(
  child: ReturnType<typeof spawn>,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => {
    exited = true;
  });
  return waitFor(() => predicate() || exited, timeoutMs).then(() => predicate());
}

const realNonoSuite = realNono ? describe : describe.skip;
realNonoSuite(
  realNono ? `cli#516 — real nono (${realNono})` : `cli#516 — real nono SKIPPED: ${realNonoSkip}`,
  () => {
    for (const fromBase of [false, true]) {
    test(`the fixture launch denies an untracked base file with base cwd/config ${fromBase}`, () => {
      const sb = makeRealNonoSandbox();
      try {
        // A trusted base location: the launch resolves the sibling `tps` next
        // to the workspace (this call runs in-process, so ~/ops/tps would be
        // the test runner's home, not the sandbox's).
        const base = join(dirname(sb.ws), "tps");
        mkdirSync(base, { recursive: true });
        const g = (args: string[], cwd = base) =>
          spawnSync("git", args, { cwd, encoding: "utf-8" });
        g(["init", "-q"]);
        g(["config", "user.email", "agent-a@tps.dev"]);
        g(["config", "user.name", "agent-a"]);
        writeFileSync(join(base, "checked-out.txt"), "from the base repository\n");
        g(["add", "checked-out.txt"]);
        g(["commit", "-qm", "init"]);
        // Untracked in the base repository's working tree, never committed.
        writeFileSync(join(base, "untracked-in-base.txt"), "base-untracked\n");
        rmSync(sb.ws, { recursive: true, force: true });

        // Create a deferred worktree as the launch's parent does, and resolve
        // its git metadata the same way, so the grant set below is built from
        // the real worktree layout.
        g(["-C", base, "worktree", "add", "--no-checkout", sb.ws, "--detach"]);
        const gitDir = g(["-C", sb.ws, "rev-parse", "--absolute-git-dir"]).stdout.trim();
        expect(gitDir).not.toBe("");
        checkoutWorktree(sb.ws);

        rmSync(join(sb.home, ".config", "nono", "profiles"), { recursive: true });
        // The launch grants ~/.bun; create it so nono does not warn on stdout.
        mkdirSync(join(sb.home, ".bun"), { recursive: true });
        const env = { ...process.env, HOME: sb.home, XDG_STATE_HOME: join(sb.root, "nono-state") };
        const cfg = fromBase ? join(base, "agent.yaml") : join(sb.home, ".tps", "agents", "probe", "agent.yaml");
        writeFileSync(cfg, agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"));

        const approval = agentLaunchOptions({
          configPath: cfg,
          cwd: fromBase ? base : sb.run,
          workspace: sb.ws,
          launchId: "probe",
          runtime: "codex",
          home: sb.home,
          env,
          mailDir: join(sb.home, ".tps", "mail"),
          tmpDir: sb.tmp,
          agentDir: join(sb.home, ".tps", "agents", "probe"),
        });
        expect(approval.refusal).toBeNull();
        for (const dir of approval.runtimeDirectories) mkdirSync(dir, { recursive: true, mode: 0o700 });

        const token = randomBytes(8).toString("hex");
        const deniedMarker = `${NONO_PROBE_DENIED_PREFIX}${token}`;
        const probe = spawnSync(
          realNono as string,
          buildNonoArgs(
            runtimeNonoProfile("codex"),
            approval.options,
            [
              "sh",
              "-c",
              `cat "$1" || echo CONTROL-UNREADABLE; cat "$2" 2>/dev/null || echo "${NONO_PROBE_DENIED_PREFIX}$3"`,
              "sh",
              join(sb.ws, "checked-out.txt"),
              join(base, "untracked-in-base.txt"),
              token,
            ],
            env,
          ),
          { cwd: fromBase ? base : sb.run, encoding: "utf-8", env },
        );
        const lines = probe.stdout.trim().split("\n");
        expect(probe.status, `nono run exited ${probe.status}: ${probe.stderr}`).toBe(0);
        expect(lines[0]).toBe("from the base repository");
        expect(lines[1]).toBe(deniedMarker);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 40_000);
    }

    test("an unrelated fixture worktree launched from the base is denied read and write of a base file", () => {
      const sb = makeRealNonoSandbox();
      try {
        // The trusted base sits beside the workspace, as it does for a launch
        // whose current directory is the base.
        const base = join(dirname(sb.ws), "tps");
        mkdirSync(base, { recursive: true });
        const g = (args: string[], cwd = base) => spawnSync("git", args, { cwd, encoding: "utf-8" });
        g(["init", "-q"]);
        g(["config", "user.email", "agent-a@tps.dev"]);
        g(["config", "user.name", "agent-a"]);
        writeFileSync(join(base, "base-secret.txt"), "base-secret\n");
        g(["add", "base-secret.txt"]);
        g(["commit", "-qm", "init"]);

        // An unrelated repository's worktree: its marker is a regular file,
        // but the trusted base's registry does not list it.
        const other = join(sb.root, "unrelated");
        mkdirSync(other, { recursive: true });
        const go = (args: string[]) => spawnSync("git", args, { cwd: other, encoding: "utf-8" });
        go(["init", "-q"]);
        go(["config", "user.email", "agent-a@tps.dev"]);
        go(["config", "user.name", "agent-a"]);
        writeFileSync(join(other, "workspace-file.txt"), "workspace-file\n");
        go(["add", "workspace-file.txt"]);
        go(["commit", "-qm", "init"]);
        const ws = join(sb.root, "unrelated-ws");
        go(["worktree", "add", "--detach", ws]);

        rmSync(join(sb.home, ".config", "nono", "profiles"), { recursive: true });
        mkdirSync(join(sb.home, ".bun"), { recursive: true });
        const env = { ...process.env, HOME: sb.home, XDG_STATE_HOME: join(sb.root, "nono-state") };
        const cfg = join(sb.home, ".tps", "agents", "probe", "agent.yaml");
        writeFileSync(cfg, agentYaml(sb, ws).replace("provider: ollama", "provider: openai"));
        const approval = agentLaunchOptions({
          configPath: cfg,
          cwd: base,
          workspace: ws,
          launchId: "probe",
          runtime: "codex",
          home: sb.home,
          env,
          mailDir: join(sb.home, ".tps", "mail"),
          tmpDir: sb.tmp,
          agentDir: join(sb.home, ".tps", "agents", "probe"),
        });
        expect(approval.refusal).toBeNull();
        expect(approval.options.cwd).toBe(ws);
        for (const dir of approval.runtimeDirectories) mkdirSync(dir, { recursive: true, mode: 0o700 });

        const token = randomBytes(8).toString("hex");
        const deniedRead = `${NONO_PROBE_DENIED_PREFIX}${token}`;
        const deniedWrite = `${NONO_PROBE_DENIED_PREFIX}write-${token}`;
        const probe = spawnSync(
          realNono as string,
          buildNonoArgs(
            runtimeNonoProfile("codex"),
            approval.options,
            [
              "sh",
              "-c",
              `cat "$1" || echo CONTROL-UNREADABLE; cat "$2" 2>/dev/null || echo "${NONO_PROBE_DENIED_PREFIX}$3"; (echo tampered > "$2") 2>/dev/null && echo WRITE-ALLOWED || echo "${NONO_PROBE_DENIED_PREFIX}write-$3"`,
              "sh",
              join(ws, "workspace-file.txt"),
              join(base, "base-secret.txt"),
              token,
            ],
            env,
          ),
          { cwd: base, encoding: "utf-8", env },
        );
        const lines = probe.stdout.trim().split("\n");
        expect(probe.status, `nono run exited ${probe.status}: ${probe.stderr}`).toBe(0);
        expect(lines[0]).toBe("workspace-file");
        expect(lines[1]).toBe(deniedRead);
        expect(lines[2]).toBe(deniedWrite);
        expect(readFileSync(join(base, "base-secret.txt"), "utf-8")).toBe("base-secret\n");
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 40_000);

    for (const variant of ["regular", "symlink", "symlink-relative"] as const) {
    test(`the default re-exec child starts in the custom workspace with config ${variant}`, async () => {
      const sb = makeRealNonoSandbox();
      let child: ReturnType<typeof spawn> | undefined;
      let out = "";
      try {
        // The default config points at one workspace and the custom config at a
        // different one; the runtime writes `.tps-agent.pid` into ITS workspace,
        // so the file's location shows which config the child loaded.
        const wsDefault = join(sb.root, "ws-default");
        const wsCustom = join(sb.root, "ws-custom");
        const customDir = join(sb.root, "custom");
        for (const d of [wsDefault, wsCustom, customDir]) mkdirSync(d, { recursive: true });
        seedRealNonoProfiles(sb.home);
        writeFileSync(join(sb.home, ".tps", "agents", "probe", "agent.yaml"), agentYaml(sb, wsDefault));
        const target = join(customDir, "agent.yaml");
        writeFileSync(target, agentYaml(sb, variant === "symlink-relative" ? "ws-custom" : wsCustom));
        const customConfig = variant === "regular" ? target : join(sb.root, "config-link.yaml");
        if (variant !== "regular") symlinkSync(target, customConfig);

        child = spawn(
          NODE,
          [TPS_BIN, "agent", "start", "--config", customConfig, SANDBOX_REQUIRED],
          {
            cwd: sb.run,
            detached: true,
            env: {
              ...process.env,
              HOME: sb.home,
              [NONO_BIN_ENV]: realNono as string,
              XDG_STATE_HOME: join(sb.root, "nono-state"),
              TPS_LAUNCH_TIMEOUT_MS: "20000",
            },
          },
        );
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const customPid = join(wsCustom, ".tps-agent.pid");
        const loaded = await waitWhileRunning(
          child,
          () => canRead(customPid) && /released under nono session \S+ \(child pid \d+\)/.test(out),
          45_000,
        );

        expect(loaded, `no pid file in the custom workspace; launcher output:\n${out}`).toBe(true);
        // The child did NOT fall back to the default config's workspace.
        expect(canRead(join(wsDefault, ".tps-agent.pid"))).toBe(false);
      } finally {
        // Signal and check the release PID and launcher, or the group without a release line.
        const stopped = !child || await stopRealLaunch(child, out);
        rmSync(sb.root, { recursive: true, force: true });
        expect(stopped, "teardown could not confirm the released child and launcher are gone").toBe(true);
      }
    }, 60_000);

    }

    for (const relativeWorkspace of [false, true]) {
    test(`the sandboxed child checks out a worktree with relative workspace ${relativeWorkspace}`, async () => {
      const sb = makeRealNonoSandbox();
      let child: ReturnType<typeof spawn> | undefined;
      let out = "";
      try {
        const base = join(sb.home, "ops", "tps");
        mkdirSync(base, { recursive: true });
        const g = (args: string[], cwd = base) =>
          spawnSync("git", args, { cwd, encoding: "utf-8" });
        g(["init", "-q"]);
        g(["config", "user.email", "agent-a@tps.dev"]);
        g(["config", "user.name", "agent-a"]);
        writeFileSync(join(base, "checked-out.txt"), "from the base repository\n");
        g(["add", "-A"]);
        g(["commit", "-qm", "init"]);
        rmSync(sb.ws, { recursive: true, force: true });

        seedRealNonoProfiles(sb.home);
        const cfg = join(sb.home, ".tps", "agents", "probe", "agent.yaml");
        writeFileSync(cfg, agentYaml(sb, relativeWorkspace ? relative(dirname(cfg), sb.ws) : sb.ws).replace("provider: ollama", "provider: openai"));

        child = spawn(
          NODE,
          [TPS_BIN, "agent", "start", "--config", cfg, "--runtime", "codex", SANDBOX_REQUIRED],
          {
            cwd: sb.run,
            detached: true,
            env: {
              ...process.env,
              HOME: sb.home,
              [NONO_BIN_ENV]: realNono as string,
              XDG_STATE_HOME: join(sb.root, "nono-state"),
              TPS_LAUNCH_TIMEOUT_MS: "20000",
            },
          },
        );
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const checkedOut = await waitWhileRunning(
          child,
          () => out.includes("worktree checked out") && canRead(join(sb.ws, "checked-out.txt")),
          45_000,
        );

        // Git reported checkout success inside the sandbox.
        expect(checkedOut, `no checkout report; launcher output:\n${out}`).toBe(true);
      } finally {
        // Signal and check the release PID and launcher, or the group without a release line.
        const stopped = !child || await stopRealLaunch(child, out);
        rmSync(sb.root, { recursive: true, force: true });
        expect(stopped, "teardown could not confirm the released child and launcher are gone").toBe(true);
      }
    }, 60_000);
    }
  },
);

// ---------------------------------------------------------------------------
// cli#660 — the real launcher's own cleanup calls
// ---------------------------------------------------------------------------

describe("cli#660 — real launcher worktree ownership", () => {
  const GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout?.trim() || "git";

  interface LaunchFixture {
    sb: Sandbox;
    base: string;
  }

  /** A base repository at <home>/ops/tps, an absent workspace, fake nono and a codex config. */
  function launchFixture(grantInBase?: (base: string) => string): LaunchFixture {
    const sb = makeSandbox();
    try {
      const base = join(sb.home, "ops", "tps");
      mkdirSync(base, { recursive: true });
      const git = (args: string[]) => {
        const result = spawnSync(GIT, args, { cwd: base, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      git(["init", "-q"]);
      git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "init"]);
      rmSync(sb.ws, { recursive: true, force: true });
      installFakeNono(sb, "  :");
      const profiles = join(sb.home, ".config", "nono", "profiles");
      writeProfilePair(profiles, "tps-agent-run-codex");
      if (grantInBase) {
        const grantPath = grantInBase(base);
        // A write grant inside the base makes the launch check that runs after
        // setup refuse, while the check before setup passes because the
        // workspace did not exist yet.
        writeFileSync(
          join(profiles, "tps-base-fixture.json"),
          JSON.stringify({
            $schema: "https://nono.sh/schemas/nono-profile.schema.json",
            meta: { name: "tps-base-fixture" },
            workdir: { access: "readwrite" },
            filesystem: { read: ["/usr", "/bin", "/lib", "/lib64"], allow: [grantPath], deny: [] },
          }),
        );
      }
      writeFileSync(
        join(sb.home, ".tps", "agents", "probe", "agent.yaml"),
        agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"),
      );
      return { sb, base };
    } catch (err) {
      rmSync(sb.root, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * A git wrapper that, on the second `rev-parse --absolute-git-dir` run in the
   * workspace (the launch check after setup), replaces the worktree with a
   * detached one at the same commit and then runs real Git. `replaced` is
   * written once the swap has run.
   */
  function replaceAtLaunchCheck(f: LaunchFixture, commit: string): { replaced: string; path: string } {
    const bin = join(f.sb.root, "bin");
    mkdirSync(bin);
    const afterSetup = join(f.sb.root, "setup-metadata-read");
    const replaced = join(f.sb.root, "replaced");
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ] && [ "$(pwd -P)" = "${f.sb.ws}" ]; then`,
        `  if [ -f "${replaced}" ]; then :; elif [ -f "${afterSetup}" ]; then`,
        `    "${GIT}" -C "${f.base}" worktree remove --force "${f.sb.ws}" >/dev/null 2>&1`,
        `    "${GIT}" -C "${f.base}" worktree add --detach "${f.sb.ws}" "${commit}" >/dev/null 2>&1`,
        `    : > "${replaced}"`,
        "    cd /",
        `    exec "${GIT}" -C "${f.sb.ws}" "$@"`,
        "  else",
        `    : > "${afterSetup}"`,
        "  fi",
        "fi",
        `exec "${GIT}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    return { replaced, path: `${bin}:${process.env.PATH}` };
  }

  function start(sb: Sandbox, path?: string) {
    return runLauncher(
      ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
      { cwd: sb.run, env: cliEnv(sb, path ? { PATH: path } : {}) },
    );
  }

  test("the later launch-check failure leaves a same-path detached replacement and prints the refusal", () => {
    const f = launchFixture((base) => join(base, "scratch"));
    const commit = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: f.base, encoding: "utf8" }).stdout.trim();
    const wrapper = replaceAtLaunchCheck(f, commit);
    try {
      const result = start(f.sb, wrapper.path);
      const text = output(result);
      expect(text).toContain("WorktreeGrantError: grant overlaps the base working tree");
      expect(text).toContain(`worktree cleanup binding changed for ${f.sb.ws}`);
      expect(text).toContain(
        `remove it manually with: git -C '${f.base}' worktree remove --force '${f.sb.ws}'`,
      );
      expect(existsSync(wrapper.replaced), text).toBe(true);
      // The replacement survives with its .git file, registry entry and HEAD.
      const gitFile = readFileSync(join(f.sb.ws, ".git"), "utf-8");
      expect(gitFile.startsWith("gitdir: ")).toBe(true);
      const gitDir = realpathSync(resolve(f.sb.ws, gitFile.trim().slice("gitdir: ".length)));
      expect(readFileSync(join(gitDir, "gitdir"), "utf-8").trim()).toBe(join(f.sb.ws, ".git"));
      expect(spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: f.sb.ws, encoding: "utf8" }).stdout.trim()).toBe(commit);
      expect(spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: f.base, encoding: "utf8" }).stdout).toContain(f.sb.ws);
    } finally {
      rmSync(f.sb.root, { recursive: true, force: true });
    }
  });

  /** The report a confined child sends: the scripted peer reads the launcher's
   *  own inside canary and reports the OUTSIDE canary DENIED. It states the
   *  report rather than producing it with a permission denial, which no uid
   *  can enforce on root (the Docker lane runs as root, where chmod 000 does
   *  not stop a child reading the canary). */
  const RELEASE_PEER = `const { connect } = require("node:net");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const sockPath = process.env.TPS_LAUNCH_SOCK;
const inside = readFileSync(join(dirname(sockPath), "canary-inside"), "utf-8");
const sock = connect(sockPath);
sock.on("error", () => process.exit(0));
sock.on("connect", () => {
  sock.write("PID " + process.pid + "\\n");
  sock.write("CANARY OUTSIDE DENIED\\n");
  sock.write("CANARY INSIDE READ:" + inside + "\\n");
});
sock.on("close", () => process.exit(0));
setTimeout(() => process.exit(0), 15000);
`;

  /** A fake nono that spawns the scripted peer and reports the live session, so
   *  the launcher releases the child; the fake stops the child after two
   *  seconds so the launch ends and the launcher runs its teardown. */
  const RELEASE_FAKE_NONO = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi
if [ "\${1:-}" = "profile" ]; then exit 0; fi
printf '%s\\n' "ARGV $*" >> "\${NONO_ARGV_LOG:?}"
if [ "\${1:-}" = "why" ]; then echo '{"status":"denied","reason":"path_not_granted"}'; exit 0; fi
if [ "\${1:-}" = "ps" ]; then
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -s "\${FAKE_NONO_PS_JSON:?}" ] && break
    sleep 0.05
  done
  cat "\${FAKE_NONO_PS_JSON:?}"; exit 0
fi
if [ "\${1:-}" = "run" ]; then
  "\${RELEASE_PEER_NODE:?}" "\${RELEASE_PEER:?}" &
  child=$!
  prof=""; args=("$@"); i=0
  for ((i=0; i<\${#args[@]}; i++)); do [ "\${args[$i]}" = "--profile" ] && prof="\${args[$((i+1))]}"; done
  printf '[{"session_id":"fixture","supervisor_pid":%s,"child_pid":%s,"status":"running","profile":"%s"}]\\n' "$$" "$child" "$prof" > "\${FAKE_NONO_PS_JSON:?}"
  sleep 2
  kill -TERM "$child" 2>/dev/null || true
  wait "$child"; exit $?
fi
exit 0
`;

  test("teardown after a released launch leaves a same-path detached replacement and prints the refusal", () => {
    const f = launchFixture();
    const commit = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: f.base, encoding: "utf8" }).stdout.trim();
    const wrapper = replaceAtLaunchCheck(f, commit);
    // A released launch: the fake nono spawns the scripted peer and reports
    // the live session, then stops the child, so the launcher runs its
    // teardown after the launch ends.
    const peer = join(f.sb.root, "release-peer.cjs");
    writeFileSync(peer, RELEASE_PEER);
    writeFileSync(f.sb.nonoBin, RELEASE_FAKE_NONO);
    chmodSync(f.sb.nonoBin, 0o755);
    try {
      const result = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED], {
        cwd: f.sb.run,
        encoding: "utf8",
        timeout: 30_000,
        env: cliEnv(f.sb, {
          PATH: wrapper.path,
          FAKE_NONO_PS_JSON: join(f.sb.root, "ps.json"),
          RELEASE_PEER_NODE: NODE,
          RELEASE_PEER: peer,
          TPS_LAUNCH_TIMEOUT_MS: "8000",
        }),
      });
      const text = output(result);
      expect(text).toContain("released under nono session");
      expect(text).toContain(`worktree cleanup binding changed for ${f.sb.ws}`);
      expect(text).toContain(
        `remove it manually with: git -C '${f.base}' worktree remove --force '${f.sb.ws}'`,
      );
      expect(existsSync(wrapper.replaced), text).toBe(true);
      const gitFile = readFileSync(join(f.sb.ws, ".git"), "utf-8");
      const gitDir = realpathSync(resolve(f.sb.ws, gitFile.trim().slice("gitdir: ".length)));
      expect(readFileSync(join(gitDir, "gitdir"), "utf-8").trim()).toBe(join(f.sb.ws, ".git"));
      // The running runtime moved HEAD during the launch; teardown must leave a
      // resolvable HEAD and the registration in place.
      expect(spawnSync(GIT, ["rev-parse", "--verify", "HEAD"], { cwd: f.sb.ws, encoding: "utf8" }).status).toBe(0);
      expect(spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: f.base, encoding: "utf8" }).stdout).toContain(f.sb.ws);
    } finally {
      rmSync(f.sb.root, { recursive: true, force: true });
    }
  });

  test("teardown removes the owned worktree after the runtime moved HEAD", () => {
    const f = launchFixture();
    const headFile = join(f.sb.root, "runtime-head");
    installFakeNono(
      f.sb,
      `  "${GIT}" -C "\${MOVE_HEAD_IN:?}" -c user.name=fixture -c user.email=fixture@example.com commit --allow-empty -qm runtime-move >/dev/null 2>&1 || true\n` +
        `  "${GIT}" -C "\${MOVE_HEAD_IN:?}" rev-parse HEAD > "${headFile}"`,
    );
    const before = spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: f.base, encoding: "utf8" }).stdout.trim();
    try {
      const result = runLauncher(
        ["agent", "start", "--id", "probe", "--runtime", "codex", SANDBOX_REQUIRED],
        { cwd: f.sb.run, env: cliEnv(f.sb, { MOVE_HEAD_IN: f.sb.ws }) },
      );
      expect(readFileSync(headFile, "utf-8").trim(), output(result)).not.toBe(before);
      expect(existsSync(f.sb.ws)).toBe(false);
      expect(spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: f.base, encoding: "utf8" }).stdout).not.toContain(f.sb.ws);
    } finally {
      rmSync(f.sb.root, { recursive: true, force: true });
    }
  });
});
