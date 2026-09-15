/**
 * cli#341 S1a — the launch-path control.
 *
 *   T2 = the env bypass is gone: `TPS_FORCE_NO_NONO=1` no longer turns the control
 *        off, and `--no-sandbox` is refused outside an interactive TTY.
 *   T3 = a generated unit that dropped `--sandbox-required` is refused by the
 *        launcher in a non-TTY context.
 *   T4 = the KeepAlive clause: generated agent units use `{SuccessfulExit:false}`
 *        ONLY together with "the launcher logs the refusal and exits 0".
 *   T5 = the re-exec child carries `--sandbox-required` verbatim, so the shipped
 *        unit actually launches (nono-present path; fake nono logs argv).
 *   T6 = `--sandboxed` cannot skip the sandbox from a non-TTY caller (only a
 *        verifiable nono child may assert it).
 *
 * The launcher cases spawn the real built binary (`dist/bin/tps.js`) with piped
 * stdio — a non-TTY context — so they exercise the same path launchd would.
 * Flag/env literals are duplicated here on purpose: these tests must fail on
 * `main` (where none of this exists) as well as pass on the branch.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildPlist } from "../src/commands/mail-watch.js";
import { generateOfficePlist, generateTunnelPlist } from "../src/commands/office-supervision.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const SANDBOX_REQUIRED = "--sandbox-required";
const NO_SANDBOX = "--no-sandbox";
const SUPERVISED = "TPS_SUPERVISED";

/** Run the built launcher with piped stdio (stdin/stdout are NOT a TTY). */
function runLauncher(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", [TPS_BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function output(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) {
    throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
  }
});

// ---------------------------------------------------------------------------
// T2 — env bypass removed; --no-sandbox is interactive-TTY-only
// ---------------------------------------------------------------------------

describe("T2 — env bypass gone / --no-sandbox is TTY-only", () => {
  test("TPS_FORCE_NO_NONO=1 cannot rescue a non-TTY --no-sandbox (refused, exit 78)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", NO_SANDBOX, SANDBOX_REQUIRED], {
      TPS_FORCE_NO_NONO: "1",
    });
    const out = output(r).toLowerCase();
    expect(out).toContain(NO_SANDBOX);
    expect(out).toContain("interactive tty");
    expect(r.status).toBe(78);
  });
});

// ---------------------------------------------------------------------------
// T3 — a generated unit missing --sandbox-required is refused in non-TTY
// ---------------------------------------------------------------------------

describe("T3 — missing --sandbox-required is refused in non-TTY", () => {
  test("agent launcher without the flag is refused (names the flag, exit 78)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost"]);
    const out = output(r);
    expect(out).toContain(SANDBOX_REQUIRED);
    expect(r.status).toBe(78);
  });

  test("the same invocation WITH the flag is not refused for that reason (reaches config check)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED]);
    const out = output(r);
    expect(out).not.toContain(`${SANDBOX_REQUIRED} is required`);
    expect(r.status).toBe(1); // config not found → the control let it through
  });
});

// ---------------------------------------------------------------------------
// T5 — the re-exec child must carry --sandbox-required (nono PRESENT path)
// ---------------------------------------------------------------------------

describe("T5 — the re-exec child carries --sandbox-required and the agent starts", () => {
  test("nono-present agent start: child argv asserts the flag; the agent actually starts", () => {
    const home = mkdtempSync(join(tmpdir(), "tps-reexec-argv-"));
    try {
      const binDir = join(home, "bin");
      const logPath = join(home, "nono-argv.log");
      mkdirSync(binDir, { recursive: true });
      // A fake nono that records its argv, sets the marker real nono sets for
      // its child, then execs the wrapped command.
      const shim = [
        "#!/usr/bin/env bash",
        `echo "NONO-ARGV $*" >> ${JSON.stringify(logPath)}`,
        'export NONO_CAP_FILE="${NONO_CAP_FILE:-/tmp/nono-fake-cap.json}"',
        'args=("$@")',
        "cmd=()",
        "seen=0",
        'for a in "${args[@]}"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done',
        'exec "${cmd[@]}"',
        "",
      ].join("\n");
      const shimPath = join(binDir, "nono");
      writeFileSync(shimPath, shim, "utf-8");
      chmodSync(shimPath, 0o755);

      const ws = join(home, "ws");
      const agentDir = join(home, ".tps", "agents", "probe");
      mkdirSync(ws, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      // The fake nono "enforces": make the denied state dir unwritable so the
      // child's capability probe is REFUSED (this is what real nono does via the
      // tps-base deny). Without this, the child correctly proves it is not
      // confined and refuses to run.
      mkdirSync(join(home, ".tps", "secrets"), { recursive: true });
      chmodSync(join(home, ".tps", "secrets"), 0o000);
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
          `mailDir: ${join(home, ".tps", "mail")}\n` +
          `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
          `llm:\n  provider: ollama\n  model: probe-model\n`,
        "utf-8",
      );

      const r = spawnSync("bun", [TPS_BIN, "agent", "start", "--id", "probe", SANDBOX_REQUIRED], {
        encoding: "utf-8",
        timeout: 3000,
        killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: home },
      });

      const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      // The child (re-exec under nono) must carry BOTH flags...
      expect(log).toContain("--sandboxed");
      expect(log).toContain(SANDBOX_REQUIRED);
      expect(log).toContain("agent start --id probe");
      // ...and must not be refused (which under a supervisor would exit 0 and
      // silently never launch the agent).
      expect(output(r)).not.toContain(`${SANDBOX_REQUIRED} is required`);

      // The agent actually started: the runtime writes its pid file first thing.
      const pidPath = join(ws, ".tps-agent.pid");
      expect(existsSync(pidPath)).toBe(true);
      if (existsSync(pidPath)) {
        const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    } finally {
      try {
        chmodSync(join(home, ".tps", "secrets"), 0o700);
      } catch {
        /* best-effort: restore so the tree can be removed */
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — --sandboxed is only honoured when the caller is verifiably inside nono
// ---------------------------------------------------------------------------

describe("T6 — --sandboxed cannot skip the sandbox from a non-TTY caller (proof by capability)", () => {
  test("plain --sandboxed is refused, naming the flag, exit 78", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED, "--sandboxed"]);
    const out = output(r);
    expect(out).toContain("--sandboxed");
    expect(out.toLowerCase()).toContain("not confined");
    expect(r.status).toBe(78);
  });

  test("planting NONO_CAP_FILE does NOT make it sufficient (refused)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED, "--sandboxed"], {
      NONO_CAP_FILE: "/tmp/nono-cap-test.json",
    });
    expect(output(r)).toContain("--sandboxed");
    expect(r.status).toBe(78);
  });

  test("a shadowed 'ps' on PATH does NOT make it sufficient (refused)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-fake-ps-"));
    try {
      const fakePs = join(dir, "ps");
      writeFileSync(fakePs, "#!/bin/sh\necho nono\n", "utf-8");
      chmodSync(fakePs, 0o755);
      const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED, "--sandboxed"], {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      });
      expect(output(r)).toContain("--sandboxed");
      expect(r.status).toBe(78);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a self-named 'nono' parent (exec -a) does NOT make it sufficient (refused)", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `exec -a nono bun ${TPS_BIN} agent start --id ghost ${SANDBOX_REQUIRED} --sandboxed`,
      ],
      { encoding: "utf-8", env: { ...process.env } },
    );
    expect(output(r)).toContain("--sandboxed");
    expect(r.status).toBe(78);
  });
});

// ---------------------------------------------------------------------------
// T4 — KeepAlive coupling on the generated units + exit-0-on-refusal
// ---------------------------------------------------------------------------

describe("T4 — KeepAlive {SuccessfulExit:false} only with exit-0-on-refusal", () => {
  test("mail-watch unit asserts the flag, marks itself supervised, and couples KeepAlive", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(xml).not.toContain("<key>Crashed</key>");
    expect(xml).toContain(`<string>${SANDBOX_REQUIRED}</string>`);
    expect(xml).toMatch(/<key>TPS_SUPERVISED<\/key>\s*<string>1<\/string>/);
    expect(xml).toContain("logs the refusal and exits 0");
  });

  test("office unit couples KeepAlive; the tunnel unit stays bare KeepAlive:true", () => {
    const office = generateOfficePlist({ name: "s1a", home: "/tmp/s1a-home" });
    expect(office).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(office).toContain(`<string>${SANDBOX_REQUIRED}</string>`);
    expect(office).toMatch(/<key>TPS_SUPERVISED<\/key>\s*<string>1<\/string>/);

    const tunnel = generateTunnelPlist({
      name: "s1a",
      localPort: 33700,
      tunnelVia: "host",
      home: "/tmp/s1a-home",
    });
    expect(tunnel).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(tunnel).not.toContain("SuccessfulExit");
  });

  test("exit-0-on-refusal: a supervised refusal exits 0, so {SuccessfulExit:false} cannot storm", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost"], { [SUPERVISED]: "1" });
    expect(output(r)).toContain(SANDBOX_REQUIRED);
    expect(r.status).toBe(0);
  });
});
