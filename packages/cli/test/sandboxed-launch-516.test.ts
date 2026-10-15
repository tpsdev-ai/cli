/**
 * cli#516 — sandboxed agent launch.
 *
 *   (1) the attested re-exec keeps `--config`: `tps agent start --config <file>`
 *       uses that file when nono is installed (the re-exec used to drop the
 *       flag and run the default config instead);
 *   (2) worktree setup/cleanup runs where it can reach the base repository: the
 *       parent, before entering the sandbox and after leaving it (a sandboxed
 *       child cannot reach the base repo's metadata, so the hooked setup quietly
 *       did nothing);
 *   (3) the sandbox-flag scan reads only tps's own arguments: a
 *       `--sandbox <word>` inside a message or a wrapped command is not a flag.
 *
 * The launcher cases spawn the built binary with piped stdio (a non-TTY context)
 * against a fake nono that logs its argv, so they fail on `main` on the
 * behaviour assertion and pass here. Flag/env literals are duplicated on purpose.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { resolve, join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveNonoBinary } from "../src/utils/launch-attestation.js";
import { NONO_MIN_VERSION, nonoVersion, versionAtLeast } from "../src/utils/nono.js";
import { sandboxHomeBase } from "./helpers/launcher-grants.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
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

function makeSandbox(): Sandbox {
  // The base must sit outside every launcher grant (cli#558): a HOME inside one
  // makes the launcher's runtime-options gate refuse before the case under test.
  const root = mkdtempSync(join(sandboxHomeBase(), "tps-516-"));
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
      // And the child can actually re-read it inside the sandbox.
      expect(child).toContain(`--read ${customDir}`);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (2) — worktree setup runs before the sandbox; a failure is a named error
// ---------------------------------------------------------------------------

describe("cli#516 (2) — worktree setup reaches the base repository", () => {
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
      // Never silently nothing: the failure stops the launch BEFORE the sandbox.
      expect(fakeNonoRuns(sb.root)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (3) — the sandbox-flag scan reads only tps's own arguments
// ---------------------------------------------------------------------------

describe("cli#516 (3) — --sandbox inside a message or wrapped command is not a flag", () => {
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

/**
 * The premise the fix rests on: inside the real nono profile the base
 * repository is NOT reachable, so a sandboxed child cannot run `git worktree`
 * against it (the old silent no-op). Runs only where a real nono >= the floor
 * is reachable by an absolute path (CI's Docker lane); the unit lane skips with
 * a stated reason.
 */
const realNonoSuite = realNono ? describe : describe.skip;
realNonoSuite(
  realNono
    ? `cli#516 — the base repository is unreachable inside the real nono profile (${realNono})`
    : `cli#516 — real nono premise SKIPPED: ${realNonoSkip}`,
  () => {
    test("the base repo resolves outside the sandbox and does NOT inside it", () => {
      const sb = makeSandbox();
      try {
        const base = join(sb.root, "base");
        mkdirSync(base, { recursive: true });
        const g = (args: string[], cwd = base) =>
          spawnSync("git", args, { cwd, encoding: "utf-8" });
        g(["init", "-q"]);
        g(["config", "user.email", "agent-a@tps.dev"]);
        g(["config", "user.name", "agent-a"]);
        writeFileSync(join(base, "README.md"), "# base\n");
        g(["add", "README.md"]);
        g(["commit", "-qm", "init"]);

        const profileDir = join(sb.home, ".config", "nono", "profiles");
        for (const name of ["tps-base.json", "tps-agent-run.json"]) {
          writeFileSync(
            join(profileDir, name),
            readFileSync(resolve(import.meta.dir, "../nono-profiles", name), "utf-8"),
          );
        }

        // Outside: the base repo is a repo (the default the parent sees).
        const outside = g(["-C", base, "rev-parse", "--is-inside-work-tree"]);
        expect(outside.stdout.trim()).toBe("true");

        const nonoRun = (cmd: string[]) =>
          spawnSync(
            realNono as string,
            [
              "run",
              "-s",
              "--profile",
              join(profileDir, "tps-agent-run.json"),
              "--workdir",
              sb.ws,
              "--allow",
              sb.ws,
              "--",
              ...cmd,
            ],
            {
              cwd: sb.ws,
              encoding: "utf-8",
              env: { ...process.env, HOME: sb.home, XDG_STATE_HOME: join(sb.root, "nono-state") },
            },
          );

        // The sandbox ran the command at all: the granted twin is readable, so
        // an empty result below is a denial, not a nono that failed to start.
        const granted = join(sb.ws, "canary-inside");
        writeFileSync(granted, "inside-nonce");
        const grantedRead = nonoRun(["cat", granted]);
        expect(grantedRead.status).toBe(0);
        expect(grantedRead.stdout.trim()).toBe("inside-nonce");

        // Inside the real profile: the base repo is not reachable.
        const inside = nonoRun(["git", "-C", base, "rev-parse", "--is-inside-work-tree"]);
        expect(inside.stdout.trim()).not.toBe("true");
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 40_000);
  },
);
