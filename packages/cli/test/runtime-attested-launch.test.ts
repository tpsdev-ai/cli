/**
 * Selected runtime re-exec and startup with simulated canary denial.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
const SANDBOX_REQUIRED = "--sandbox-required";
const NONO_BIN_ENV = "NONO_BIN";
const TIMEOUT_ENV = "TPS_LAUNCH_TIMEOUT_MS";
const RUNTIMES = ["claude-code", "codex", "gemini"] as const;

const startup = {
  "claude-code": "Claude Code runtime started.",
  codex: "Codex runtime started.",
  gemini: "Gemini runtime started.",
};

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

function makeSandbox(): Sandbox {
  const base = process.platform === "linux" ? "/var/tmp" : tmpdir();
  const root = mkdtempSync(join(base, "tps-363-rt-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  const nonoDir = join(root, "nono");
  for (const d of [home, tmp, ws, nonoDir]) mkdirSync(d, { recursive: true });
  seedHome(home, ws);
  return { root, home, tmp, ws, nonoDir, nonoLog: join(root, "nono.log") };
}

/** Simulates canary denial and a session record; provides no sandbox. */
const CANARY_FAKE_NONO = `#!/usr/bin/env bash
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
    HOME: "../home",
    SNOOPLOGG: "tps:agent*",
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
    test(`agent start --runtime ${rt} --sandbox-required is released and starts its runner`, async () => {
      const sb = makeSandbox();
      try {
        const bin = writeFakeNono(sb, CANARY_FAKE_NONO);
        const { text, stopped } = await runUntil(
          sb,
          ["agent", "start", "--id", "probe", "--runtime", rt, SANDBOX_REQUIRED],
          { [NONO_BIN_ENV]: bin, FAKE_NONO_PS_JSON: join(sb.root, "ps.json") },
          (t) => t.includes(startup[rt]),
          30_000
        );
        expect(text).toContain(startup[rt]);
        expect(stopped).toBe(true);
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

describe("conflicting sandbox flags", () => {
  for (const rt of RUNTIMES) {
    for (const tty of [true, false]) {
      test(`${rt}: conflicting flags are refused before dispatch (TTY=${tty})`, () => {
        const sb = makeSandbox();
        try {
          const preload = join(sb.root, "tty.cjs");
          writeFileSync(preload, `Object.defineProperty(process.stdin, "isTTY", {value: ${tty}});\nObject.defineProperty(process.stdout, "isTTY", {value: ${tty}});\n`);
          const r = spawnSync(NODE, ["--require", preload, TPS_BIN, "agent", "start", "--id", "probe", "--runtime", rt, "--sandbox-required", "--no-sandbox"], {
            cwd: sb.ws, env: cliEnv(sb), encoding: "utf-8", timeout: 3000, killSignal: "SIGKILL",
          });
          const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
          expect(text).toContain("--sandbox-required conflicts with --no-sandbox");
          expect(r.status).toBe(78);
          expect(text).not.toContain(startup[rt]);
          expect(fakeNonoRuns(sb)).toEqual([]);
        } finally {
          rmSync(sb.root, {recursive: true, force: true});
        }
      });
    }
  }
});

describe("selected runner startup with interactive opt-out", () => {
  for (const rt of RUNTIMES) {
    test(`${rt}: starts its selected runner`, async () => {
      const sb = makeSandbox();
      try {
        const preload = join(sb.root, "tty.cjs");
        writeFileSync(preload, 'Object.defineProperty(process.stdin, "isTTY", {value: true});\nObject.defineProperty(process.stdout, "isTTY", {value: true});\n');
        const { text, stopped } = await runUntil(sb,
          ["agent", "start", "--id", "probe", "--runtime", rt, "--no-sandbox"],
          { NODE_OPTIONS: `--require=${preload}` },
          (t) => t.includes(startup[rt]), 5000);
        expect(text).toContain(startup[rt]);
        expect(stopped).toBe(true);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });
  }
});

function interactiveRuntimeProbe(sb: Sandbox, rt: string | undefined, noSandbox = false, equals = false, flags: string[] = []) {
  const defaultMarker = join(sb.root, "default-started");
  const selectedMarker = join(sb.root, "selected-started");
  const preload = join(sb.root, "interactive.mjs");
  const agentModule = resolve(import.meta.dir, "../../agent/dist/index.js");
  writeFileSync(preload, `
import { AgentRuntime } from ${JSON.stringify(agentModule)};
import { writeFileSync } from "node:fs";
Object.defineProperty(process.stdin, "isTTY", {value: true});
Object.defineProperty(process.stdout, "isTTY", {value: true});
AgentRuntime.prototype.start = async function () {
  writeFileSync(${JSON.stringify(defaultMarker)}, "started");
  process.exit(0);
};
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = function (chunk, ...args) {
    if (String(chunk).includes(${JSON.stringify(startup[rt as keyof typeof startup] ?? "unsupported runtime started.")})) {
      writeFileSync(${JSON.stringify(selectedMarker)}, "started");
      write(chunk, ...args);
      process.exit(0);
    }
    return write(chunk, ...args);
  };
}
`);
  const result = spawnSync(NODE, ["--import", preload, TPS_BIN, "agent", "start", "--id", "probe", ...(rt ? equals ? [`--runtime=${rt}`] : ["--runtime", rt] : []), ...(noSandbox ? ["--no-sandbox"] : []), ...flags], {
    cwd: sb.ws,
    env: cliEnv(sb, { [NONO_BIN_ENV]: join(sb.nonoDir, "missing"), TPS_NONO_STRICT: undefined, TPS_SUPERVISED: undefined }),
    encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
  });
  return { status: result.status, text: `${result.stdout ?? ""}${result.stderr ?? ""}`, defaultMarker, selectedMarker };
}

describe("interactive selected runtime with no nono", () => {
  for (const rt of RUNTIMES) {
    test(`${rt}: refuses before either runtime starts`, () => {
      const sb = makeSandbox();
      try {
        const result = interactiveRuntimeProbe(sb, rt);
        expect(result.text).toContain(`refusing to launch runtime '${rt}'`);
        expect(result.text).toContain("no nono at the pinned absolute path");
        expect(result.text).toContain("--no-sandbox");
        expect(result.status).toBe(78);
        expect(existsSync(result.defaultMarker)).toBe(false);
        expect(existsSync(result.selectedMarker)).toBe(false);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });

    test(`${rt}: refused launch can retry with explicit --no-sandbox`, () => {
      const sb = makeSandbox();
      try {
        const refused = interactiveRuntimeProbe(sb, rt);
        expect(refused.status).toBe(78);
        expect(existsSync(refused.defaultMarker)).toBe(false);
        expect(existsSync(refused.selectedMarker)).toBe(false);
        const optedOut = interactiveRuntimeProbe(sb, rt, true);
        expect(optedOut.status).toBe(0);
        expect(optedOut.text).toContain(startup[rt]);
        expect(existsSync(optedOut.selectedMarker)).toBe(true);
        expect(existsSync(optedOut.defaultMarker)).toBe(false);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });
  }
});


test("interactive default runtime with no nono still warns and starts", () => {
  const sb = makeSandbox();
  try {
    const result = interactiveRuntimeProbe(sb, undefined);
    expect(result.status).toBe(0);
    expect(result.text).toContain("nono not found — starting WITHOUT sandbox isolation");
    expect(existsSync(result.defaultMarker)).toBe(true);
    expect(existsSync(result.selectedMarker)).toBe(false);
  } finally {
    rmSync(sb.root, {recursive: true, force: true});
  }
});

for (const noSandbox of [false, true]) {
  test(`unsupported runtime never falls back to the default (opt-out=${noSandbox})`, () => {
    const sb = makeSandbox();
    try {
      const result = interactiveRuntimeProbe(sb, "unsupported", noSandbox);
      expect(result.status).toBe(78);
      expect(result.text).toContain("refusing to launch runtime 'unsupported': unsupported runtime");
      expect(existsSync(result.defaultMarker)).toBe(false);
      expect(existsSync(result.selectedMarker)).toBe(false);
    } finally {
      rmSync(sb.root, {recursive: true, force: true});
    }
  });
}

for (const rt of RUNTIMES) {
  test(`${rt}: --runtime=value also requires an explicit opt-out`, () => {
    const sb = makeSandbox();
    try {
      const refused = interactiveRuntimeProbe(sb, rt, false, true);
      expect(refused.status).toBe(78);
      expect(existsSync(refused.defaultMarker)).toBe(false);
      expect(existsSync(refused.selectedMarker)).toBe(false);
      const optedOut = interactiveRuntimeProbe(sb, rt, true, true);
      expect(optedOut.status).toBe(0);
      expect(existsSync(optedOut.selectedMarker)).toBe(true);
      expect(existsSync(optedOut.defaultMarker)).toBe(false);
    } finally {
      rmSync(sb.root, {recursive: true, force: true});
    }
  });
}

for (const rt of RUNTIMES) {
  for (const flags of [
    ["--sandbox-required=true", "--no-sandbox"],
    ["--sandboxRequired=true", "--noSandbox"],
    ["--sandbox-required=true", "--no_sandbox=true"],
    ["--sandbox-required=true", "--no-sandbox=true"],
    ["--sandbox-required=unknown", "--no-sandbox"],
    ["--no-sandbox=unknown"],
    ["--noSandbox", "unknown", "--no-sandbox"],
  ]) {
    test(`${rt}: TTY refuses ${flags.join(" ")} before either runner starts`, () => {
      const sb = makeSandbox();
      try {
        const result = interactiveRuntimeProbe(sb, rt, false, false, flags);
        expect(result.status).toBe(78);
        expect(result.text).toContain(flags.some(f => f.includes("unknown")) ? "cannot interpret sandbox flag" : "--sandbox-required conflicts with --no-sandbox");
        expect(existsSync(result.defaultMarker)).toBe(false);
        expect(existsSync(result.selectedMarker)).toBe(false);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });
  }
  for (const value of ["false"]) {
    test(`${rt}: --sandbox-required=${value} reads as false and allows TTY opt-out`, () => {
      const sb = makeSandbox();
      try {
        const result = interactiveRuntimeProbe(sb, rt, true, false, [`--sandbox-required=${value}`]);
        expect(result.status).toBe(0);
        expect(existsSync(result.selectedMarker)).toBe(true);
        expect(existsSync(result.defaultMarker)).toBe(false);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });
  }
  for (const value of ["false"]) {
    test(`${rt}: --no-sandbox=${value} does not opt out`, () => {
      const sb = makeSandbox();
      try {
        const result = interactiveRuntimeProbe(sb, rt, false, false, [`--no-sandbox=${value}`]);
        expect(result.status).toBe(78);
        expect(result.text).toContain("no nono at the pinned absolute path");
        expect(existsSync(result.defaultMarker)).toBe(false);
        expect(existsSync(result.selectedMarker)).toBe(false);
      } finally {
        rmSync(sb.root, {recursive: true, force: true});
      }
    });
  }
}
for (const equals of [false, true]) {
  test(`explicit openclaw keeps the default runtime (equals=${equals})`, () => {
    const sb = makeSandbox();
    try {
      const result = interactiveRuntimeProbe(sb, "openclaw", false, equals);
      expect(result.status).toBe(0);
      expect(result.text).toContain("nono not found — starting WITHOUT sandbox isolation");
      expect(existsSync(result.defaultMarker)).toBe(true);
      expect(existsSync(result.selectedMarker)).toBe(false);
    } finally {
      rmSync(sb.root, {recursive: true, force: true});
    }
  });
}

for (const rt of RUNTIMES) {
  for (const spelling of ["no-sandbox", "noSandbox"]) {
    for (const value of ["true"]) {
      test(`${rt}: TTY --${spelling}=${value} starts only the selected runner`, () => {
        const sb = makeSandbox();
        try {
          const result = interactiveRuntimeProbe(sb, rt, false, false, [`--${spelling}=${value}`]);
          expect(result.status).toBe(0);
          expect(existsSync(result.selectedMarker)).toBe(true);
          expect(existsSync(result.defaultMarker)).toBe(false);
          expect(fakeNonoRuns(sb)).toEqual([]);
        } finally {
          rmSync(sb.root, {recursive: true, force: true});
        }
      });
    }
  }
}

for (const rt of RUNTIMES) {
  for (const spelling of ["sandbox-required", "sandboxRequired", "sandbox", "no-sandbox", "noSandbox", "sandboxed"]) {
    for (const value of ["1", "0", "yes", "", "TRUE"]) {
      test(`${rt}: invalid --${spelling}=${value} refuses before any runner`, () => {
        const sb = makeSandbox();
        try {
          const result = interactiveRuntimeProbe(sb, rt, true, false, [`--${spelling}=${value}`]);
          expect(result.status).toBe(78);
          expect(result.text).toContain(`--${spelling} accepts only 'true' or 'false'`);
          expect(existsSync(result.selectedMarker)).toBe(false);
          expect(existsSync(result.defaultMarker)).toBe(false);
          expect(fakeNonoRuns(sb)).toEqual([]);
        } finally {
          rmSync(sb.root, {recursive: true, force: true});
        }
      });
    }
  }
  test(`${rt}: --sandbox=false does not opt out with missing nono`, () => {
    const sb = makeSandbox();
    try {
      const result = interactiveRuntimeProbe(sb, rt, false, false, ["--sandbox=false"]);
      expect(result.status).toBe(78);
      expect(result.text).toContain("no nono at the pinned absolute path");
      expect(existsSync(result.selectedMarker)).toBe(false);
      expect(existsSync(result.defaultMarker)).toBe(false);
      expect(fakeNonoRuns(sb)).toEqual([]);
    } finally {
      rmSync(sb.root, {recursive: true, force: true});
    }
  });
}

// ---------------------------------------------------------------------------
// cli#483 — a runtime directory or an inherited launch grant that overlaps a TPS
// credential root is refused before any runner starts.
// ---------------------------------------------------------------------------

/**
 * Run the launcher for a selected runtime in a non-TTY context (the attested
 * path) with a dummy nono, so the ONLY control that can refuse is the
 * credential guard. Without the extra directory the launcher would proceed to
 * the attested launch.
 */
function runtimeDirProbe(sb: Sandbox, rt: string, extraEnv: Record<string, string | undefined>) {
  const bin = writeFakeNono(sb, "#!/usr/bin/env bash\nexit 0\n");
  const r = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", rt, SANDBOX_REQUIRED], {
    cwd: sb.ws,
    env: cliEnv(sb, { [NONO_BIN_ENV]: bin, ...extraEnv }),
    encoding: "utf-8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  return { status: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("cli#483 — a custom runtime directory overlapping a credential root is refused before any runner", () => {
  const cases = [
    { rt: "claude-code", variable: "CLAUDE_CONFIG_DIR", root: "auth" },
    { rt: "codex", variable: "CODEX_HOME", root: "identity" },
    { rt: "gemini", variable: "XDG_CONFIG_HOME", root: "auth" },
  ] as const;

  for (const { rt, variable, root } of cases) {
    test(`${rt}: ${variable} resolving inside ~/.tps/${root} refuses 78, before any spawn`, () => {
      const sb = makeSandbox();
      try {
        const value = join(sb.home, ".tps", root);
        const { status, text } = runtimeDirProbe(sb, rt, { [variable]: value });
        expect(status).toBe(78);
        expect(text).toContain(variable);
        expect(text).toContain(`~/.tps/${root}`);
        expect(fakeNonoRuns(sb)).toEqual([]);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  test("claude-code: a current directory inside ~/.tps/auth refuses 78, before any spawn", () => {
    const sb = makeSandbox();
    try {
      const auth = join(sb.home, ".tps", "auth");
      mkdirSync(auth, { recursive: true });
      const bin = writeFakeNono(sb, "#!/usr/bin/env bash\nexit 0\n");
      const r = spawnSync(NODE, [TPS_BIN, "agent", "start", "--id", "probe", "--runtime", "claude-code", SANDBOX_REQUIRED], {
        cwd: auth,
        env: cliEnv(sb, { [NONO_BIN_ENV]: bin, HOME: sb.home }),
        encoding: "utf-8",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      expect(r.status).toBe(78);
      expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("current-directory grant");
      expect(fakeNonoRuns(sb)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

describe("cli#483 — an unrelated runtime directory still launches", () => {
  test("claude-code: an unrelated CLAUDE_CONFIG_DIR is released and starts its runner", async () => {
    const sb = makeSandbox();
    try {
      const bin = writeFakeNono(sb, CANARY_FAKE_NONO);
      const custom = join(sb.root, "claude-custom");
      const { text, stopped } = await runUntil(
        sb,
        ["agent", "start", "--id", "probe", "--runtime", "claude-code", SANDBOX_REQUIRED],
        { [NONO_BIN_ENV]: bin, FAKE_NONO_PS_JSON: join(sb.root, "ps.json"), CLAUDE_CONFIG_DIR: custom },
        (t) => t.includes(startup["claude-code"]),
        30_000,
      );
      expect(stopped).toBe(true);
      expect(text).toContain(startup["claude-code"]);
      expect(text).not.toContain("overlaps the TPS credential root");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  }, 40_000);
});
