/**
 * cli#363 slice B — `agent start --runtime claude-code|codex|gemini` runs
 * through the attested launch, so it is confined like every other agent launch.
 *
 * Slice A refused `--sandbox-required` on these runtimes because `bin/tps.ts`
 * branched on `--runtime` BEFORE `runAgent({action:"start"})` and spawned the
 * runtime directly, so it never reached `launchAttested()` and was not confined
 * by nono. Slice B routes them through the same attested launch (the runtime is
 * carried into the nono re-exec), so the flag is honoured rather than refused.
 *
 * These tests are black box and FAIL on `main`: they spawn the built CLI with
 * piped stdio (non-TTY, the shape a generated unit or a wrapper uses) against a
 * fake nono at an absolute path, and assert the REAL launch decision — that the
 * launcher spawned nono for a re-exec that carries `--runtime <rt>` and released
 * the child — never an exported helper. The fake nono "confines" the way the
 * profile does (it denies the child the launcher's OUTSIDE canary), so the child
 * attests and the launcher releases it; on `main` the slice-A refusal fires
 * instead and nono is never spawned.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
const SANDBOX_REQUIRED = "--sandbox-required";
const NONO_BIN_ENV = "NONO_BIN";
const TIMEOUT_ENV = "TPS_LAUNCH_TIMEOUT_MS";
const RUNTIMES = ["claude-code", "codex", "gemini"] as const;

// Real launches wait on a release window; raise the file default above it.
setDefaultTimeout(60_000);

beforeAll(() => {
  if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  ws: string;
  nonoDir: string;
  nonoLog: string;
}

/** A fixture HOME (agent.yaml, mail, identity, JSON profile pair) + a nono dir. */
function seedHome(home: string, ws: string): void {
  const agentDir = join(home, ".tps", "agents", "probe");
  const profileDir = join(home, ".config", "nono", "profiles");
  for (const d of [agentDir, profileDir, join(home, ".tps", "mail"), join(home, ".tps", "identity")]) {
    mkdirSync(d, { recursive: true });
  }
  const base = {
    $schema: "https://nono.sh/schemas/nono-profile.schema.json",
    meta: { name: "tps-base-fixture" },
    workdir: { access: "readwrite" },
    filesystem: { read: ["/usr", "/bin", "/lib", "/lib64"], deny: [] },
  };
  const run = {
    $schema: "https://nono.sh/schemas/nono-profile.schema.json",
    extends: "tps-base-fixture",
    meta: { name: "tps-agent-run" },
    workdir: { access: "readwrite" },
  };
  writeFileSync(join(profileDir, "tps-base-fixture.json"), JSON.stringify(base, null, 2));
  writeFileSync(join(profileDir, "tps-agent-run.json"), JSON.stringify(run, null, 2));
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
      `mailDir: ${join(home, ".tps", "mail")}\n` +
      `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
      `llm:\n  provider: ollama\n  model: probe-model\n`
  );
  writeFileSync(join(home, ".tps", "identity", "probe.key"), "fixture-key\n");
  writeFileSync(join(home, ".tps", "identity", "probe.pub"), "fixture-pub\n");
}

/** OUTSIDE /tmp: the launch grants /tmp, so a HOME under /tmp would put the
 * private dir inside that grant and the overlap assert would refuse (correctly). */
function makeSandbox(): Sandbox {
  const base = existsSync("/var/tmp") ? "/var/tmp" : homedir();
  const root = mkdtempSync(join(base, "tps-363-rt-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  const nonoDir = join(root, "nono");
  for (const d of [home, tmp, ws, nonoDir]) mkdirSync(d, { recursive: true });
  seedHome(home, ws);
  return { root, home, tmp, ws, nonoDir, nonoLog: join(root, "nono.log") };
}

/**
 * A fake nono that "confines": for `run` it denies the child the launcher's
 * OUTSIDE canary (chmod 000 — the launcher read it BEFORE the spawn), starts the
 * wrapped command as its own child, and publishes a `ps` store bound to the real
 * pids it spawned, so the launcher's canary + binding checks pass and it
 * RELEASES the child. Anything else (`--version`, `profile validate`) exits 0.
 */
const CONFINING_FAKE_NONO = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi
log="\${FAKE_NONO_LOG:?}"
printf '%s\\n' "ARGV $*" >> "$log"
if [ "\${1:-}" = "ps" ]; then
  if [ -n "\${FAKE_NONO_PS_JSON:-}" ] && [ -f "\${FAKE_NONO_PS_JSON}" ]; then cat "\${FAKE_NONO_PS_JSON}"; else echo "[]"; fi
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  cmd=(); seen=0
  for a in "$@"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done
  if [ -n "\${TPS_LAUNCH_SOCK:-}" ]; then
    priv="$(dirname "$(dirname "$TPS_LAUNCH_SOCK")")"
    [ -f "$priv/canary-outside" ] && chmod 000 "$priv/canary-outside"
  fi
  "\${cmd[@]}" &
  child=$!
  echo "CHILD $child SUP \$\$" >> "$log"
  prof=""; args=("$@"); i=0
  for ((i=0; i<\${#args[@]}; i++)); do [ "\${args[$i]}" = "--profile" ] && prof="\${args[$((i+1))]}"; done
  printf '[{"session_id":"fixture","supervisor_pid":%s,"child_pid":%s,"status":"running","profile":"%s"}]\\n' "$$" "$child" "$prof" > "\${FAKE_NONO_PS_JSON:?}"
  wait "$child"; exit $?
fi
exit 0
`;

function writeFakeNono(sb: Sandbox, script: string): string {
  const path = join(sb.nonoDir, "nono");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function cliEnv(sb: Sandbox, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: sb.home,
    TMPDIR: sb.tmp,
    FAKE_NONO_LOG: sb.nonoLog,
    [TIMEOUT_ENV]: "8000",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

/** ARGV lines the fake nono logged for a `run` (the launcher's spawn). */
function fakeNonoRuns(sb: Sandbox): string[] {
  if (!existsSync(sb.nonoLog)) return [];
  return readFileSync(sb.nonoLog, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("ARGV run"))
    .map((l) => l.slice(5));
}

/** Spawn the launcher, accumulate output, stop the whole tree when done. */
async function runUntil(
  sb: Sandbox,
  args: string[],
  extra: Record<string, string | undefined>,
  done: (text: string) => boolean,
  waitMs: number
): Promise<{ text: string; stopped: boolean }> {
  const child: ChildProcess = spawn(NODE, [TPS_BIN, ...args], {
    cwd: sb.ws,
    env: cliEnv(sb, extra),
    // Own process group so a fixture can stop the launcher, the fake nono and
    // the wrapped runtime in one signal — never a pattern kill.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  const reached = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), waitMs);
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf-8");
      if (done(text)) {
        clearTimeout(timer);
        resolvePromise(true);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      resolvePromise(done(text));
    });
  });
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return { text, stopped: reached };
}

const real = process.getuid?.() !== 0 ? describe : describe.skip;

real("cli#363 slice B — the three runtimes reach the attested launch", () => {
  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} --sandbox-required is routed through the launcher and released`, async () => {
      const sb = makeSandbox();
      try {
        const bin = writeFakeNono(sb, CONFINING_FAKE_NONO);
        const { text, stopped } = await runUntil(
          sb,
          ["agent", "start", "--id", "probe", "--runtime", rt, SANDBOX_REQUIRED],
          { [NONO_BIN_ENV]: bin, FAKE_NONO_PS_JSON: join(sb.root, "ps.json") },
          (t) => t.includes("released under nono session"),
          30_000
        );
        expect(stopped).toBe(true);
        // The launcher's release is proof of confinement (canaries + session
        // binding); its absence would mean the control refused.
        expect(text).toContain("released under nono session");
        // The runtime is not refused by the retired slice-A rule.
        expect(text).not.toContain("not launched through the attested sandbox");
        expect(text).not.toContain("READ the OUTSIDE canary");
        // The launcher spawned nono for a re-exec that carries this runtime and
        // the sandboxed marker — i.e. the runtime launch went through the
        // attested launch, not a direct spawn.
        const runs = fakeNonoRuns(sb).join("\n");
        expect(runs).toContain("run --profile");
        expect(runs).toContain(`--runtime ${rt}`);
        expect(runs).toContain("--sandboxed");
        expect(runs).toContain("agent start");
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 40_000);
  }
});

describe("cli#363 slice B — the existing launch refusals still apply on the runtime path", () => {
  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} --no-sandbox outside a TTY is refused 78, before any spawn`, () => {
      const sb = makeSandbox();
      try {
        const r = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", rt, "--no-sandbox"], {
          encoding: "utf-8",
          cwd: sb.ws,
          timeout: 20_000,
          env: cliEnv(sb),
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        expect(text).toContain("--no-sandbox is refused");
        expect(r.status).toBe(78);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 25_000);
  }

  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} without --sandbox-required (non-TTY) is refused 78, before any spawn`, () => {
      const sb = makeSandbox();
      try {
        const r = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", rt], {
          encoding: "utf-8",
          cwd: sb.ws,
          timeout: 20_000,
          env: cliEnv(sb),
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        expect(text).toContain(`${SANDBOX_REQUIRED} is required`);
        expect(r.status).toBe(78);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 25_000);
  }
});

describe("cli#363 slice B — confinement unavailable is refused before any spawn", () => {
  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} --sandbox-required with no pinned nono refuses 78, before spawning the runtime`, () => {
      const sb = makeSandbox();
      try {
        // A fake runtime binary on PATH: if the CLI spawned the runtime despite
        // no nono, it would write this marker. It must not.
        const fakeBinDir = join(sb.root, "fakebin");
        mkdirSync(fakeBinDir, { recursive: true });
        const marker = join(sb.root, "runtime-spawned");
        const runtimeCmd = rt === "claude-code" ? "claude" : rt; // claude-code spawns `claude`
        const fake = join(fakeBinDir, runtimeCmd);
        writeFileSync(fake, `#!/usr/bin/env bash\necho spawned > ${JSON.stringify(marker)}\n`);
        chmodSync(fake, 0o755);

        const r = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", rt, SANDBOX_REQUIRED], {
          encoding: "utf-8",
          cwd: sb.ws,
          timeout: 20_000,
          env: cliEnv(sb, {
            [NONO_BIN_ENV]: join(sb.nonoDir, "does-not-exist"),
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          }),
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        // On `main` the retired slice-A rule refuses instead; this reason is the
        // attested launch's own missing-nono refusal, so the assertion is red there.
        expect(text).toContain("no nono at the pinned absolute path");
        expect(text).not.toContain("not launched through the attested sandbox");
        expect(r.status).toBe(78);
        expect(fakeNonoRuns(sb)).toEqual([]); // nothing was launched
        expect(existsSync(marker)).toBe(false); // the runtime was never spawned
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    }, 25_000);
  }
});
