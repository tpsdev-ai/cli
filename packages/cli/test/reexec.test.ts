/**
 * Re-exec pattern tests — ops-12.1 follow-up
 *
 * Verifies that hire, roster, and review each:
 *   1. Re-exec themselves under nono when TPS_NONO_ACTIVE is NOT set
 *   2. Skip re-exec when TPS_NONO_ACTIVE=1 (double-wrap guard)
 *   3. Apply the correct profile per command
 *   4. Validate workspace paths BEFORE the re-exec (Sherlock concern #1)
 *
 * NOTE: TPS_NONO_ACTIVE is a double-wrap guard only — not a security boundary.
 * Kernel-level policy enforcement is done by the nono sandbox itself.
 *
 * Uses the fake nono binary from ~/ops/fakes/nono/bin/nono.
 * All tests spawn the real `tps` binary (dist/bin/tps.js) under controlled env.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "node:path";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const FAKE_NONO_BIN_DIR = join(import.meta.dir, "fakes/nono/bin");
const FAKE_NONO_BIN = join(FAKE_NONO_BIN_DIR, "nono");
const FAKE_PROFILES_DIR = join(import.meta.dir, "fakes/nono/profiles");
const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const PERSONAS_DIR = resolve(import.meta.dir, "../personas");

if (!existsSync(FAKE_NONO_BIN)) {
  throw new Error(`Fake nono binary not found at ${FAKE_NONO_BIN}. Run 'git pull' in ~/ops.`);
}
if (!existsSync(TPS_BIN)) {
  throw new Error(`tps binary not found at ${TPS_BIN}. Run 'npm run build' in ~/tps.`);
}

let tmpDir: string;
let fakeLog: string;
let origPath: string;
let origHome: string | undefined;
let origNonoStrict: string | undefined;
let origNonoActive: string | undefined;
let origForceNoNono: string | undefined;

/** Spawn tps with fake nono on PATH and our env overrides. */
function runTps(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string
) {
  return spawnSync("bun", [TPS_BIN, ...args], {
    encoding: "utf-8",
    cwd: cwd ?? tmpDir,
    env: {
      ...process.env,
      // Prepend fake nono so it's found first; real PATH supplies node/system tools
      PATH: `${FAKE_NONO_BIN_DIR}:${process.env.PATH}`,
      NONO_FAKE_LOG: fakeLog,
      NONO_PROFILES_DIR: FAKE_PROFILES_DIR,
      TPS_NONO_STRICT: undefined,
      TPS_NONO_ACTIVE: undefined,
      ...env,
    },
  });
}

/**
 * PATH without the fake nono dir — node and system tools still available,
 * but `which nono` returns nothing, simulating nono not installed.
 */
function pathWithoutNono(): string {
  // Rather than trying to mangle PATH (which fails because the real nono
  // or other binaries might still be found), we use the escape hatch.
  process.env.TPS_FORCE_NO_NONO = "1";
  return process.env.PATH ?? "";
}

function readLog(): string {
  if (!existsSync(fakeLog)) return "";
  return readFileSync(fakeLog, "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tps-reexec-test-"));
  fakeLog = join(tmpDir, "nono-fake.log");
  origPath = process.env.PATH!;
  origHome = process.env.HOME;
  origNonoStrict = process.env.TPS_NONO_STRICT;
  origNonoActive = process.env.TPS_NONO_ACTIVE;
  origForceNoNono = process.env.TPS_FORCE_NO_NONO;
  process.env.HOME = tmpDir; // prevent cross-test HOME pollution
});

afterEach(() => {
  process.env.PATH = origPath;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origNonoStrict !== undefined) process.env.TPS_NONO_STRICT = origNonoStrict;
  else delete process.env.TPS_NONO_STRICT;
  if (origNonoActive !== undefined) process.env.TPS_NONO_ACTIVE = origNonoActive;
  else delete process.env.TPS_NONO_ACTIVE;
  if (origForceNoNono !== undefined) process.env.TPS_FORCE_NO_NONO = origForceNoNono;
  else delete process.env.TPS_FORCE_NO_NONO;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// hire re-exec
// ─────────────────────────────────────────────────────────────────────────────
describe("hire: re-exec guard", () => {
  test("re-execs under tps-hire profile when nono available", () => {
    const r = runTps(["hire", "developer", "--name", "TestBot"]);
    const log = readLog();
    expect(log).toContain("PROFILE_LOADED profile=tps-hire");
    expect(log).toContain("INVOKE");
  });

  test("skips re-exec and runs directly when TPS_NONO_ACTIVE=1", () => {
    const r = runTps(["hire", "developer", "--name", "TestBot"], {
      TPS_NONO_ACTIVE: "1",
    });
    const log = readLog();
    // nono should not have been invoked
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("uses tps-hire profile (not roster or review)", () => {
    runTps(["hire", "developer"]);
    const log = readLog();
    expect(log).toContain("profile=tps-hire");
    expect(log).not.toContain("profile=tps-roster");
    expect(log).not.toContain("profile=tps-review");
  });

  test("passes --workdir when --workspace is given (path inside ~/.openclaw/)", () => {
    // S1.5: workspace must be inside ~/.openclaw/ — use a valid path
    const ws = join(process.env.HOME!, ".openclaw", "workspace-testbot-reexec");
    mkdirSync(ws, { recursive: true });
    try {
      runTps(["hire", "developer", "--workspace", ws]);
      const log = readLog();
      // fake nono logs workdir=<path> on the INVOKE line
      expect(log).toContain(`workdir=${ws}`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("validates report file path BEFORE re-exec (non-existent file)", () => {
    const r = runTps(["hire", "/nonexistent/report.tps"]);
    expect(r.status).not.toBe(0);
    // stderr or stdout — console.error may go to either depending on ink/node version
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output).toContain("TPS report not found");
    // nono should not have been invoked — error happened before re-exec
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("built-in personas skip file existence check", () => {
    // 'developer' is a built-in persona — should reach nono even though no file
    runTps(["hire", "developer"]);
    const log = readLog();
    expect(log).toContain("PROFILE_LOADED profile=tps-hire");
  });

  test("exits non-zero when nono unavailable and strict mode on", () => {
    const r = runTps(["hire", "developer"], {
      PATH: pathWithoutNono(),
      TPS_NONO_STRICT: "1",
      TPS_FORCE_NO_NONO: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? "").toContain("TPS_NONO_STRICT");
  });

  test("warns and continues when nono unavailable (non-strict)", () => {
    const r = runTps(["hire", "developer", "--dry-run"], {
      PATH: pathWithoutNono(),
      TPS_FORCE_NO_NONO: "1",
    });
    // Should warn but proceed; stderr has the nono warning
    expect(r.stderr ?? "").toContain("nono not found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roster re-exec
// ─────────────────────────────────────────────────────────────────────────────
describe("roster: re-exec guard", () => {
  test("re-execs under tps-roster profile when nono available", () => {
    runTps(["roster"]);
    const log = readLog();
    expect(log).toContain("PROFILE_LOADED profile=tps-roster");
    expect(log).toContain("INVOKE");
  });

  test("skips re-exec when TPS_NONO_ACTIVE=1", () => {
    runTps(["roster"], { TPS_NONO_ACTIVE: "1" });
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("uses tps-roster profile (not hire or review)", () => {
    runTps(["roster"]);
    const log = readLog();
    expect(log).toContain("profile=tps-roster");
    expect(log).not.toContain("profile=tps-hire");
    expect(log).not.toContain("profile=tps-review");
  });

  test("passes no --workdir (roster is read-only)", () => {
    runTps(["roster"]);
    const log = readLog();
    // --workdir should not be in the invocation for roster
    expect(log).not.toContain("--workdir");
  });

  test("exits non-zero when nono unavailable and strict mode on", () => {
    const r = runTps(["roster"], {
      PATH: pathWithoutNono(),
      TPS_NONO_STRICT: "1",
      TPS_FORCE_NO_NONO: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? "").toContain("TPS_NONO_STRICT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// review re-exec
// ─────────────────────────────────────────────────────────────────────────────
describe("review: re-exec guard", () => {
  let configPath: string;
  let agentWorkspace: string;

  beforeEach(() => {
    // Set up a minimal openclaw.json with one agent
    agentWorkspace = join(tmpDir, "workspace-testbot");
    mkdirSync(agentWorkspace, { recursive: true });
    writeFileSync(join(agentWorkspace, "SOUL.md"), "# TestBot\n");

    configPath = join(tmpDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "testbot", name: "TestBot", workspace: agentWorkspace },
          ],
        },
      }, null, 2)
    );
  });

  test("re-execs under tps-review-local profile when nono available", () => {
    runTps(["review", "testbot", "--config", configPath]);
    const log = readLog();
    expect(log).toContain("PROFILE_LOADED profile=tps-review-local");
    expect(log).toContain("INVOKE");
  });

  test("re-execs under tps-review-deep when --deep is passed", () => {
    runTps(["review", "testbot", "--deep", "--config", configPath]);
    const log = readLog();
    expect(log).toContain("PROFILE_LOADED profile=tps-review-deep");
  });

  test("skips re-exec when TPS_NONO_ACTIVE=1", () => {
    runTps(["review", "testbot", "--config", configPath], {
      TPS_NONO_ACTIVE: "1",
    });
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("passes agent workspace as --workdir", () => {
    runTps(["review", "testbot", "--config", configPath]);
    const log = readLog();
    // fake nono logs workdir=<path> on the INVOKE line
    expect(log).toContain(`workdir=${agentWorkspace}`);
  });

  test("exits with error BEFORE re-exec when agent workspace is missing", () => {
    // Remove the workspace dir
    rmSync(agentWorkspace, { recursive: true, force: true });

    const r = runTps(["review", "testbot", "--config", configPath]);
    expect(r.status).not.toBe(0);
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output).toContain("workspace does not exist");
    // nono should not have been invoked
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("uses local profile by default (not deep)", () => {
    runTps(["review", "testbot", "--config", configPath]);
    const log = readLog();
    expect(log).toContain("profile=tps-review-local");
    expect(log).not.toContain("profile=tps-review-deep");
  });

  test("exits non-zero when nono unavailable and strict mode on", () => {
    const r = runTps(["review", "testbot", "--config", configPath], {
      PATH: pathWithoutNono(),
      TPS_NONO_STRICT: "1",
      TPS_FORCE_NO_NONO: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? "").toContain("TPS_NONO_STRICT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S1.5 — workspace path boundary validation (hire)
// ─────────────────────────────────────────────────────────────────────────────
describe("hire: S1.5 — workspace path boundary", () => {
  test("rejects --workspace outside ~/.openclaw/", () => {
    const r = runTps(["hire", "developer", "--workspace", `${process.env.HOME}/.ssh`]);
    expect(r.status).not.toBe(0);
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output).toContain("~/.openclaw/");
    // nono should not have been invoked
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("rejects --workspace pointing to /tmp", () => {
    const r = runTps(["hire", "developer", "--workspace", "/tmp/evil"]);
    expect(r.status).not.toBe(0);
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output).toContain("~/.openclaw/");
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });

  test("accepts --workspace inside ~/.openclaw/", () => {
    const ws = `${process.env.HOME}/.openclaw/workspace-testbot`;
    runTps(["hire", "developer", "--workspace", ws]);
    const log = readLog();
    // Validation passed — nono was invoked
    expect(log).toContain("PROFILE_LOADED profile=tps-hire");
  });

  test("rejects --workspace equal to ~/.openclaw itself (root pollution guard)", () => {
    const ws = `${process.env.HOME}/.openclaw`;
    const r = runTps(["hire", "developer", "--workspace", ws]);
    expect(r.status).not.toBe(0);
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output).toContain("subdirectory only");
    const log = readLog();
    expect(log).not.toContain("PROFILE_LOADED");
  });
});
