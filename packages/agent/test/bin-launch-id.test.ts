/**
 * cli#352 r — the supervisor's launch path (`nono run … -- tps-agent start`)
 * bypassed the validated-id rule cli#351 r5 put on the CLI path: the agent's
 * writable config could name ANY id and the runtime would derive its identity
 * key from it. The launch id therefore comes from the supervisor's roster entry
 * and the config must agree.
 *
 * Black-box: spawns the built runtime with a throwaway config. `check` is the
 * supervisor's pre-flight; `start --id` applies the same rule on the launch
 * itself (and refuses before any runtime is constructed).
 */
import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const AGENT_BIN = resolve(import.meta.dir, "../dist/bin.js");

function config(agentId: string): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tps-agent-launch-id-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(path, `agentId: ${agentId}\nname: ${agentId}\nworkspace: ${dir}/ws\n`, "utf-8");
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args: string[]) {
  return spawnSync("bun", [AGENT_BIN, ...args], {
    encoding: "utf-8",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
}

describe("tps-agent launch id (cli#352 r)", () => {
  test("check accepts a config that agrees with the roster id", () => {
    const c = config("probe");
    try {
      const r = run(["check", "--id", "probe", "--config", c.path]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      c.cleanup();
    }
  });

  test("check refuses a config whose agentId disagrees, naming both", () => {
    const c = config("other");
    try {
      const r = run(["check", "--id", "probe", "--config", c.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("'other'");
      expect(r.stderr).toContain("'probe'");
      expect(r.stderr).toContain("refusing to launch");
    } finally {
      c.cleanup();
    }
  });

  test("check refuses a traversal-shaped roster id", () => {
    const c = config("probe");
    try {
      const r = run(["check", "--id", "../evil", "--config", c.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Invalid agent id");
      expect(r.stderr).toContain("../evil");
    } finally {
      c.cleanup();
    }
  });

  test("check refuses an over-long roster id", () => {
    const c = config("probe");
    try {
      const r = run(["check", "--id", "a".repeat(65), "--config", c.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Invalid agent id");
    } finally {
      c.cleanup();
    }
  });

  test("start --id refuses a disagreeing config before starting the runtime", () => {
    const c = config("other");
    try {
      const r = run(["start", "--id", "probe", "--config", c.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("'other'");
      expect(r.stderr).toContain("'probe'");
    } finally {
      c.cleanup();
    }
  });

  test("check needs both --id and --config", () => {
    const c = config("probe");
    try {
      expect(run(["check", "--id", "probe"]).status).toBe(1);
      expect(run(["check", "--config", c.path]).status).toBe(1);
    } finally {
      c.cleanup();
    }
  });
});
