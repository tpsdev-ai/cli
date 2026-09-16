/**
 * cli#341 S1a — the launch-path control.
 *
 *   T2 = the env bypass is gone: `TPS_FORCE_NO_NONO=1` no longer turns the control
 *        off, and `--no-sandbox` is refused outside an interactive TTY.
 *   T3 = a generated unit that dropped `--sandbox-required` is refused by the
 *        launcher in a non-TTY context.
 *   T4 = the KeepAlive clause: generated agent units use `{SuccessfulExit:false}`
 *        ONLY together with "the launcher logs the refusal and exits 0".
 *   T5 = the pinned-path launch spawns nono and the re-exec child argv carries
 *        `--sandboxed` + `--sandbox-required` verbatim (a fake nono logs argv).
 *   T6 = `--sandboxed` cannot skip the sandbox from a non-TTY caller: without the
 *        launcher's release (cli#350 round 4e) it is refused.
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
import { homedir } from "node:os";
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

  test("TPS_FORCE_NO_NONO=1 cannot rescue a sandbox-required launch (no --no-sandbox masking it)", () => {
    // cli#350 r4g — without --no-sandbox the previous T2 only proved the flag
    // refusal; this proves the env bypass is gone for a plain sandbox-required
    // launch: the control does not refuse for a flag reason, the env var does
    // not disable it, and the launch proceeds to the config check (exit 1).
    const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED], {
      TPS_FORCE_NO_NONO: "1",
    });
    const out = output(r);
    expect(out).not.toContain(`${SANDBOX_REQUIRED} is required`);
    expect(r.status).toBe(1); // reached the config check → not refused by the control
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
// T5 — the launch runs under nono by an ABSOLUTE path and the child argv carries
// the launch-control flags. (cli#350 round 4e rewrote this path: the launcher now
// spawns the pinned binary itself, plants the canaries and releases the child over
// its own socket. The argv shape is what this checks here; the release protocol
// has its own fixtures in launch-attestation.test.ts.)
// ---------------------------------------------------------------------------

describe("T5 — the pinned-path launch spawns nono and the child argv asserts the flags", () => {
  test("agent start --sandbox-required with a fake nono at NONO_BIN: the run argv carries both flags", () => {
    // OUTSIDE /tmp: the launch grants /tmp too (cli#350 r4g), so a /tmp HOME would
    // sit inside that grant and the overlap assert would refuse before spawning.
    const base = existsSync("/var/tmp") ? "/var/tmp" : homedir();
    const home = mkdtempSync(join(base, "tps-reexec-argv-"));
    try {
      const nonoDir = join(home, "nono");
      const profileDir = join(home, ".config", "nono", "profiles");
      const agentDir = join(home, ".tps", "agents", "probe");
      const ws = join(home, "ws");
      for (const d of [nonoDir, profileDir, agentDir, ws, join(home, ".tps", "mail"), join(home, "tmp")]) {
        mkdirSync(d, { recursive: true });
      }
      // A loadable JSON profile pair: the launcher validates before spawning.
      writeFileSync(
        join(profileDir, "tps-base-fixture.json"),
        JSON.stringify({
          $schema: "https://nono.sh/schemas/nono-profile.schema.json",
          meta: { name: "tps-base-fixture" },
          workdir: { access: "readwrite" },
          filesystem: { read: ["/usr", "/bin"], deny: [] },
        })
      );
      writeFileSync(
        join(profileDir, "tps-agent-run.json"),
        JSON.stringify({
          $schema: "https://nono.sh/schemas/nono-profile.schema.json",
          extends: "tps-base-fixture",
          meta: { name: "tps-agent-run" },
        })
      );
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
          `mailDir: ${join(home, ".tps", "mail")}\n` +
          `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
          `llm:\n  provider: ollama\n  model: probe-model\n`
      );

      const logPath = join(home, "nono-argv.log");
      const shim = [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi',
        'if [ "${1:-}" = "profile" ]; then exit 0; fi',
        'echo "NONO-ARGV $*" >> "${NONO_ARGV_LOG:?}"',
        "exit 0",
        "",
      ].join("\n");
      const shimPath = join(nonoDir, "nono");
      writeFileSync(shimPath, shim, "utf-8");
      chmodSync(shimPath, 0o755);

      spawnSync("bun", [TPS_BIN, "agent", "start", "--id", "probe", SANDBOX_REQUIRED], {
        encoding: "utf-8",
        timeout: 8000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: join(home, "tmp"),
          NONO_BIN: shimPath,
          NONO_ARGV_LOG: logPath,
          TPS_LAUNCH_TIMEOUT_MS: "1500",
        },
      });

      const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      expect(log).toContain("run --profile");
      expect(log).toContain("--sandboxed");
      expect(log).toContain(SANDBOX_REQUIRED);
      expect(log).toContain("agent start --id probe");
      // cli#350 r4g — /tmp is granted IN ADDITION to the configured TMPDIR
      // (bun's temp dir is /tmp regardless of TMPDIR).
      expect(log).toContain(`--allow ${join(home, "tmp")}`);
      expect(log).toContain("--allow /tmp");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — --sandboxed is only honoured when the caller is verifiably inside nono
// ---------------------------------------------------------------------------

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
