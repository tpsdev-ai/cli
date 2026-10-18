/**
 * cli#516 — sandboxed agent launch.
 *
 * Config and worktree launcher cases use fake nono to record argv; flag cases
 * invoke the built CLI directly. Real-nono cases skip when unavailable.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { resolve, join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolveNonoBinary } from "../src/utils/launch-attestation.js";
import {
  NONO_MIN_VERSION,
  agentLaunchGrants,
  approveRuntimeNonoOptions,
  buildNonoArgs,
  nonoVersion,
  runtimeNonoProfile,
  versionAtLeast,
} from "../src/utils/nono.js";
import { checkoutWorktree, onStart, onStop, WorktreeLifecycleError, worktreeCommonDir } from "../src/utils/agent-lifecycle.js";
import { realNonoHomeBase, sandboxHomeBase, NONO_PROBE_DENIED_PREFIX } from "./helpers/launcher-grants.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** The shipped CLI is a node script; the real-nono case must run it with node
 * (bun inside a nono sandbox sees an empty environment, so the launcher's
 * socket locator does not reach a bun child). */
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
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
  // The base must sit outside every launcher grant (cli#558): a HOME inside one
  // makes the launcher's runtime-options gate refuse before the case under test.
  // The real-nono cases pass realNonoHomeBase(), which is also outside nono's
  // own built-in grants.
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
  writeFileSync(
    join(home, ".tps", "identity", "probe.key"),
    "fixture-key\n",
  );
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

// ---------------------------------------------------------------------------
// (1) — `--config` survives the attested re-exec
// ---------------------------------------------------------------------------

describe("cli#516 (1) — the attested re-exec keeps --config", () => {
  test("agent start --config <file> re-execs with that --config and grants its directory", () => {
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

      runLauncher(
        ["agent", "start", "--config", customConfig, SANDBOX_REQUIRED],
        { cwd: sb.run, env: cliEnv(sb) },
      );

      const child = fakeNonoRuns(sb.root).find((l) => l.includes("agent start")) ?? "";
      expect(child).toContain(`--config ${customConfig}`);
      // The child is granted read of the directory, so it can re-read the file.
      expect(child).toContain(`--read ${customDir}`);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a relative --config resolves to one absolute path before the re-exec", () => {
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
      expect(child).toContain(`--config ${customAbs}`);
      expect(child).toContain(`--read ${customDir}`);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
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

  test("a worktree setup failure is reported, and the launch stops before the sandbox", () => {
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
      // A regular file blocks the workspace's parent, so `git worktree add`
      // cannot create it — on any uid, so the case also holds as root.
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
      expect(output(r)).toContain("worktree setup failed");
      expect(fakeNonoRuns(sb.root)).toEqual([]);
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
    test(`setup and cleanup classify a ${kind} candidate consistently`, () => {
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
    test(`setup and cleanup reject unresolvable ${metadata} metadata with real Git`, () => {
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
    test(`unresolvable ${metadata} metadata stops setup before nono starts`, () => {
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

    test(`unresolvable ${metadata} metadata reports a cleanup failure`, () => {
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
    // The scan must still catch tps's OWN flag, or the fix would be a bypass.
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

  test("an actual, unattested --sandboxed flag is still refused", () => {
    // The gate must still refuse tps's OWN --sandboxed, or the fix would let a
    // hand-typed claim through.
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

/** Where the real-nono fixtures live: outside the launcher's grants AND nono's
 * own built-in grants (on macOS, system_read_macos covers /var/tmp). Resolved on
 * first use, so a host without nono never queries it. */
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
    test("the launch's grants read the worktree and deny an untracked base-repository file", () => {
      const sb = makeRealNonoSandbox();
      try {
        const base = join(sb.root, "base");
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

        // Create the same deferred worktree the launch's parent creates, and
        // resolve its git metadata the same way, so the grant set below is
        // built from the real worktree layout.
        g(["-C", base, "worktree", "add", "--no-checkout", sb.ws, "--detach"]);
        const gitDir = g(["-C", sb.ws, "rev-parse", "--absolute-git-dir"]).stdout.trim();
        expect(gitDir).not.toBe("");
        const gitCommonDir = worktreeCommonDir(gitDir);
        checkoutWorktree(sb.ws);

        seedRealNonoProfiles(sb.home);
        // The launch grants ~/.bun; create it so nono does not warn on stdout.
        mkdirSync(join(sb.home, ".bun"), { recursive: true });
        const env = { ...process.env, HOME: sb.home, XDG_STATE_HOME: join(sb.root, "nono-state") };
        const cfg = join(sb.home, ".tps", "agents", "probe", "agent.yaml");
        writeFileSync(cfg, agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"));

        // The grants and profile are built by the same functions the launch
        // uses, so this cannot pass against a grant set the launch does not
        // pass. The payload is a probe instead of the re-exec.
        const grants = agentLaunchGrants({
          configPath: cfg,
          workspace: sb.ws,
          launchId: "probe",
          runtime: "codex",
          home: sb.home,
          env,
          mailDir: join(sb.home, ".tps", "mail"),
          tmpDir: sb.tmp,
          agentDir: join(sb.home, ".tps", "agents", "probe"),
          worktreeGit: { gitDir, gitCommonDir },
        });
        const approval = approveRuntimeNonoOptions(
          "codex",
          { ...grants, workdir: sb.ws, cwd: sb.run },
          env,
          "probe",
        );
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
          { cwd: sb.run, encoding: "utf-8", env },
        );
        const lines = probe.stdout.trim().split("\n");
        expect(probe.status, `nono run exited ${probe.status}: ${probe.stderr}`).toBe(0);
        expect(lines[0]).toBe("from the base repository");
        expect(lines[1]).toBe(deniedMarker);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 40_000);

    test("the re-exec child loads the custom --config, not the default", async () => {
      const sb = makeRealNonoSandbox();
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
        const customConfig = join(customDir, "agent.yaml");
        writeFileSync(customConfig, agentYaml(sb, wsCustom));

        const child = spawn(
          NODE,
          [TPS_BIN, "agent", "start", "--config", customConfig, SANDBOX_REQUIRED],
          {
            cwd: sb.run,
            env: {
              ...process.env,
              HOME: sb.home,
              [NONO_BIN_ENV]: realNono as string,
              XDG_STATE_HOME: join(sb.root, "nono-state"),
              TPS_LAUNCH_TIMEOUT_MS: "20000",
            },
          },
        );
        let out = "";
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const customPid = join(wsCustom, ".tps-agent.pid");
        const loaded = await waitWhileRunning(child, () => canRead(customPid), 45_000);

        // Stop the released agent before asserting, so a failure cannot leak it.
        let pid = Number.NaN;
        try {
          pid = Number.parseInt(readFileSync(customPid, "utf-8").trim(), 10);
        } catch {
          /* the child never wrote it (the launch refused, or used the default) */
        }
        if (Number.isInteger(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        child.kill("SIGKILL");

        expect(loaded, `no pid file in the custom workspace; launcher output:\n${out}`).toBe(true);
        // The child did NOT fall back to the default config's workspace.
        expect(canRead(join(wsDefault, ".tps-agent.pid"))).toBe(false);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 60_000);

    test("the sandboxed child checks the worktree out inside the sandbox", async () => {
      const sb = makeRealNonoSandbox();
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
        writeFileSync(cfg, agentYaml(sb, sb.ws).replace("provider: ollama", "provider: openai"));

        const child = spawn(
          NODE,
          [TPS_BIN, "agent", "start", "--config", cfg, "--runtime", "codex", SANDBOX_REQUIRED],
          {
            cwd: sb.run,
            env: {
              ...process.env,
              HOME: sb.home,
              [NONO_BIN_ENV]: realNono as string,
              XDG_STATE_HOME: join(sb.root, "nono-state"),
              TPS_LAUNCH_TIMEOUT_MS: "20000",
            },
          },
        );
        let out = "";
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const checkedOut = await waitWhileRunning(child, () => out.includes("worktree checked out"), 45_000);
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        child.kill("SIGKILL");

        // Git reported checkout success inside the sandbox.
        expect(checkedOut, `no checkout report; launcher output:\n${out}`).toBe(true);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
