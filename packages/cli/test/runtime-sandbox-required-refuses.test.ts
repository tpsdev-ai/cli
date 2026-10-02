/**
 * cli#363 slice A — `--sandbox-required` is refused on the `agent start
 * --runtime claude-code|codex|gemini` path.
 *
 * Those three runtimes branch in `bin/tps.ts` BEFORE `runAgent({action:"start"})`
 * and spawn the runtime directly, so they never reach the attested launch
 * (`launch-attestation.ts`) and are NOT confined by nono. `launchesAgent()`
 * (`nono.ts`) keys on the command name, so the launch gate used to accept
 * `--sandbox-required` on that path and the process then ran unconfined: the
 * flag asserted an isolation the path cannot deliver. The gate now refuses the
 * flag there, before dispatch, in every context.
 *
 * Black-box: spawns the built CLI with piped stdio (non-TTY), the same shape a
 * wrapper or a unit passes `--runtime` through. Flag literals are duplicated
 * here on purpose: this file must fail on `main`, where the refusal does not
 * exist.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { evaluateLaunchControl } from "../src/utils/nono.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const SANDBOX_REQUIRED = "--sandbox-required";
const RUNTIMES = ["claude-code", "codex", "gemini"] as const;
/** The binary each runtime module spawns: `spawn("claude"|"codex"|"gemini")`. */
const RUNTIME_BIN: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

interface Probe {
  home: string;
  marker: string;
  env: Record<string, string | undefined>;
  cleanup: () => void;
}

/** A throwaway HOME plus PATH stubs for the three runtime binaries. Each stub
 *  appends its name to the marker file, so a marker entry is proof it ran. */
function probe(): Probe {
  const home = mkdtempSync(join(tmpdir(), "tps-363-runtime-"));
  const binDir = join(home, "path-stubs");
  mkdirSync(binDir, { recursive: true });
  const marker = join(home, "spawned.log");
  for (const bin of Object.values(RUNTIME_BIN)) {
    const stub = join(binDir, bin);
    writeFileSync(stub, `#!/bin/sh\necho "${bin} $@" >> ${JSON.stringify(marker)}\nexit 0\n`, "utf-8");
    chmodSync(stub, 0o755);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    TPS_HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  // The refusal's exit code depends on supervisor detection; this test pins the
  // launcher (78) rather than the supervised 0.
  delete env.TPS_SUPERVISED;
  return { home, marker, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runLauncher(args: string[], env: Record<string, string | undefined>) {
  return spawnSync("bun", [TPS_BIN, ...args], {
    encoding: "utf-8",
    timeout: 5000,
    killSignal: "SIGKILL",
    env,
  });
}

function output(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

function spawned(p: Probe): string {
  return existsSync(p.marker) ? readFileSync(p.marker, "utf-8") : "";
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

describe("cli#363 — --sandbox-required is refused on the unattested runtime path", () => {
  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} --sandbox-required: refused non-zero, naming the runtime, nothing spawned`, () => {
      const p = probe();
      try {
        const r = runLauncher(
          ["agent", "start", "--id", "ghost", "--runtime", rt, SANDBOX_REQUIRED],
          p.env,
        );
        const out = output(r);
        expect(r.status).toBe(78); // non-zero, before anything is spawned
        expect(out).toContain(`--runtime ${rt}`); // names the runtime
        expect(out).toContain(SANDBOX_REQUIRED);
        expect(out).toContain("not launched through the attested sandbox");
        expect(out).toContain("#363"); // names the reason's tracking issue
        expect(spawned(p)).toBe(""); // the runtime binary was never spawned
      } finally {
        p.cleanup();
      }
    });
  }

  for (const rt of RUNTIMES) {
    test(`agent start --runtime ${rt} without --sandbox-required: the refusal for the flag is not what fires (unchanged)`, () => {
      const p = probe();
      try {
        const r = runLauncher(["agent", "start", "--id", "ghost", "--runtime", rt], p.env);
        const out = output(r);
        // Today's behaviour in a non-TTY is the pre-existing rule-2 refusal
        // (the launcher must assert the flag). This change does not touch it.
        expect(r.status).toBe(78);
        expect(out).toContain(`${SANDBOX_REQUIRED} is required`);
        expect(out).not.toContain("not launched through the attested sandbox");
      } finally {
        p.cleanup();
      }
    });
  }

  test("the spawn probe works: the stub binary records itself when it is run", () => {
    const p = probe();
    try {
      const stub = join(p.home, "path-stubs", "codex");
      const r = spawnSync(stub, ["--version"], { encoding: "utf-8", timeout: 5000 });
      expect(r.status).toBe(0);
      expect(spawned(p)).toContain("codex");
    } finally {
      p.cleanup();
    }
  });
});

describe("cli#363 — the launch gate does not treat the runtime branch as attested", () => {
  const argv = (runtime: string) => ["bun", "tps", "agent", "start", "--runtime", runtime, SANDBOX_REQUIRED];

  for (const rt of RUNTIMES) {
    test(`evaluateLaunchControl refuses the flag on --runtime ${rt}`, () => {
      const r = evaluateLaunchControl({
        command: "agent",
        rest: ["start", "--runtime", rt, SANDBOX_REQUIRED],
        argv: argv(rt),
        interactiveTty: false,
      });
      expect(r.allowed).toBe(false);
      expect(r.refusal).toContain(`--runtime ${rt}`);
      expect(r.refusal).toContain("not launched through the attested sandbox");
    });
  }

  test("the attested path is not refused by that rule (positive control)", () => {
    const r = evaluateLaunchControl({
      command: "agent",
      rest: ["start", "--id", "ghost", SANDBOX_REQUIRED],
      argv: ["bun", "tps", "agent", "start", "--id", "ghost", SANDBOX_REQUIRED],
      interactiveTty: false,
    });
    expect(r.allowed).toBe(true);
  });

  test("an interactive TTY does not rescue the flag on the runtime branch", () => {
    // The TTY case is where the flag was silently ignored: the gate's
    // "must assert --sandbox-required" rule needs !tty, and the runtime branch
    // never looked at the flag at all.
    const r = evaluateLaunchControl({
      command: "agent",
      rest: ["start", "--runtime", "codex", SANDBOX_REQUIRED],
      argv: ["bun", "tps", "agent", "start", "--runtime", "codex", SANDBOX_REQUIRED],
      interactiveTty: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.refusal).toContain("--runtime codex");
  });
});
