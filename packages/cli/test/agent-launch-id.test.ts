/**
 * cli#351 r5 — the launch grant's input must come from OUTSIDE the grantee's
 * write set.
 *
 * `~/.tps/agents/<id>/` is granted read+write to the sandboxed agent, so the
 * agent can rewrite its own agent.yaml. The launch must therefore derive the
 * grant (its own identity key) from the validated `--id` argv, and refuse when
 * the config disagrees or the id is traversal-shaped. Black-box: spawns the
 * built CLI with piped stdio (non-TTY) and a throwaway HOME.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

function setup(configAgentId: string): { home: string; configPath: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "tps-launch-id-"));
  const dir = join(home, ".tps", "agents", "launch");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "agent.yaml");
  writeFileSync(
    configPath,
    `agentId: ${configAgentId}\nname: ${configAgentId}\nworkspace: ${home}/ws\n` +
      `mailDir: ${home}/.tps/mail\nmemoryPath: ${dir}/memory.jsonl\n` +
      `llm:\n  provider: ollama\n  model: x\n`,
    "utf-8",
  );
  mkdirSync(join(home, "ws"), { recursive: true });
  return { home, configPath, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runStart(args: string[], home: string) {
  // `--sandbox-required`: every non-TTY launch through `agent start` must assert
  // it (cli#341 S1a) — the launch-path control refuses the invocation outright
  // otherwise, before the id checks below ever run.
  return spawnSync("bun", [TPS_BIN, "agent", "start", "--sandbox-required", ...args], {
    encoding: "utf-8",
    timeout: 4000,
    killSignal: "SIGKILL",
    env: { ...process.env, HOME: home, TPS_HOME: home },
  });
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

describe("agent start — launch id validation (cli#351 r5)", () => {
  test("a config whose agentId disagrees with --id is refused, naming both", () => {
    const { home, configPath, cleanup } = setup("sherlock");
    try {
      const r = runStart(["--id", "anvil", "--config", configPath], home);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(1);
      expect(out).toContain("sherlock");
      expect(out).toContain("anvil");
      expect(out).toContain("does not match the launch id");
    } finally {
      cleanup();
    }
  });

  test("a traversal-shaped agentId in the config is refused", () => {
    const { home, configPath, cleanup } = setup("../agents/victim/x");
    try {
      const r = runStart(["--id", "../agents/victim/x", "--config", configPath], home);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(1);
      expect(out).toContain("Invalid agent id");
    } finally {
      cleanup();
    }
  });

  test("a traversal-shaped --id is refused", () => {
    const { home, configPath, cleanup } = setup("probe");
    try {
      const r = runStart(["--id", "../../evil", "--config", configPath], home);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(1);
      expect(out).toContain("Invalid agent id");
    } finally {
      cleanup();
    }
  });

  test("a matching config is NOT refused by the id checks (positive control)", () => {
    const { home, configPath, cleanup } = setup("probe");
    try {
      const r = runStart(["--id", "probe", "--config", configPath], home);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(out).not.toContain("Invalid agent id");
      expect(out).not.toContain("does not match the launch id");
    } finally {
      cleanup();
    }
  });
});
