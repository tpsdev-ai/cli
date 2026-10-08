// cli#486 — the last three `?? "anvil"` identity defaults are gone: the bridge
// core, the roster dashboard and `tps agent commit` take a configured identity
// and refuse by name when none is set.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BridgeCore } from "../src/bridge/core.js";
import type { BridgeAdapter } from "../src/bridge/adapter.js";
import { runDashboard } from "../src/commands/roster.js";
import { startFetchFlair } from "./helpers/fetch-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

const savedAgentId = process.env.TPS_AGENT_ID;

function noopAdapter(): BridgeAdapter {
  return { name: "stdio", start: async () => {}, send: async () => {}, stop: async () => {} };
}

function runCommand(cmd: string, args: string[], cwd: string) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return (result.stdout ?? "").trim();
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  runCommand("git", ["init"], repo);
  runCommand("git", ["checkout", "-b", "main"], repo);
  runCommand("git", ["config", "user.name", "Test User"], repo);
  runCommand("git", ["config", "user.email", "test@example.com"], repo);
  writeFileSync(join(repo, "tracked.txt"), "base tracked\n");
  runCommand("git", ["add", "-A"], repo);
  runCommand("git", ["commit", "-m", "initial"], repo);
  return repo;
}

describe("cli#486 — configured identity, no anvil default", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(() => {
    // Restore every spy this file registered, so nothing leaks to a later file
    // in the same bun process (cli#555).
    mock.restore();
    if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
    else process.env.TPS_AGENT_ID = savedAgentId;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("bridge core refuses without a configured default agent and takes one when set", () => {
    const mailDir = mkdtempSync(join(tmpdir(), "cli486-bridge-"));
    roots.push(mailDir);
    delete process.env.TPS_AGENT_ID;

    expect(() => new BridgeCore(noopAdapter(), { mailDir, bridgeAgentId: "test-bridge" }))
      .toThrow(/no bridge default agent id/);

    process.env.TPS_AGENT_ID = "kern";
    const core = new BridgeCore(noopAdapter(), { mailDir, bridgeAgentId: "test-bridge" });
    expect((core as unknown as { defaultAgentId: string }).defaultAgentId).toBe("kern");
  });

  test("roster dashboard refuses without a configured viewer and runs when set", async () => {
    const stub = startFetchFlair({});
    const requests: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      requests.push(url.pathname);
      return Response.json(url.pathname === "/Agent/" ? [{ id: "ember" }] : []);
    });
    try {
      delete process.env.TPS_AGENT_ID;
      await expect(runDashboard({ flairUrl: stub.url })).rejects.toThrow(/no roster viewer id/);

      process.env.TPS_AGENT_ID = "kern";
      await expect(runDashboard({ flairUrl: stub.url })).resolves.toBeUndefined();
      expect(requests).toEqual(["/Agent/", "/OrgEventCatchup/kern"]);
    } finally {
      fetchSpy.mockRestore();
      stub.stop();
    }
  });

  test("agent commit refuses without a configured agent and commits when set", () => {
    const root = mkdtempSync(join(tmpdir(), "cli486-commit-"));
    roots.push(root);
    const repo = initRepo(root);

    const baseEnv = { ...process.env } as NodeJS.ProcessEnv;
    const refusalEnv = { ...baseEnv };
    delete refusalEnv.TPS_AGENT_ID;
    const refusal = spawnSync("bun", [
      TPS_BIN, "agent", "commit",
      "--repo", repo,
      "--branch", "feat/refused",
      "--message", "refused commit",
      "--author", "Ember", "ember@tps.dev",
      "--path", "tracked.txt",
    ], { cwd: repo, encoding: "utf-8", env: refusalEnv });
    expect(refusal.status).toBe(1);
    expect(refusal.stderr).toContain("no agent commit agent id");

    writeFileSync(join(repo, "tracked.txt"), "changed tracked\n");
    const accepted = spawnSync("bun", [
      TPS_BIN, "agent", "commit",
      "--repo", repo,
      "--branch", "feat/accepted",
      "--message", "accepted commit",
      "--author", "Ember", "ember@tps.dev",
      "--path", "tracked.txt",
    ], { cwd: repo, encoding: "utf-8", env: { ...baseEnv, TPS_AGENT_ID: "ember" } });
    expect(accepted.status).toBe(0);
  });
});
