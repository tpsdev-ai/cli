import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

function startBranch(agentId?: string, configuredId?: string, withConf = true) {
  const home = mkdtempSync(join(tmpdir(), "tps-branch-daemon-"));
  try {
    const root = join(home, ".tps");
    mkdirSync(root);
    if (withConf) writeFileSync(join(root, "branch.conf.json"), JSON.stringify({ port: 6458, transport: "ws", agentId: configuredId }));
    const marker = join(home, "spawned");
    const preload = join(home, "spawn.mjs");
    writeFileSync(preload, `import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { writeFileSync } from "node:fs";
      childProcess.spawn = () => {
        writeFileSync(${JSON.stringify(marker)}, "spawned");
        return { pid: 12345, unref() {} };
      };
      syncBuiltinESMExports();`);
    const env = { ...process.env, HOME: home, NODE_ENV: "production" };
    delete env.TPS_BRANCH_DAEMON;
    delete env.TPS_BRANCH_NO_DAEMON;
    delete env.TPS_AGENT_ID;
    if (agentId !== undefined) env.TPS_AGENT_ID = agentId;
    const result = spawnSync("node", ["--import", preload, TPS_BIN, "branch", "start"], {
      encoding: "utf8", env, timeout: 10_000,
    });
    return { ...result, spawned: existsSync(marker), pidWritten: existsSync(join(root, "branch.pid")), logWritten: existsSync(join(root, "branch.log")) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("branch start self-daemonization", () => {
  test("refuses without identity or branch configuration before spawning", () => {
    const result = startBranch(undefined, undefined, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no branch agent id");
    expect(result.stdout).not.toContain("started");
    expect(result.spawned).toBe(false);
    expect(result.pidWritten).toBe(false);
    expect(result.logWritten).toBe(false);
  });
  for (const id of [undefined, ""]) {
    test(`refuses ${id === undefined ? "missing" : "empty"} identity before spawning`, () => {
      const result = startBranch(id);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no branch agent id");
      expect(result.stdout).not.toContain("started");
      expect(result.spawned).toBe(false);
      expect(result.pidWritten).toBe(false);
      expect(result.logWritten).toBe(false);
    });
  }
  for (const [envId, configuredId] of [["configured-agent", undefined], [undefined, "persisted-agent"]]) {
    test(`starts with ${envId ? "environment" : "persisted"} identity`, () => {
      const result = startBranch(envId, configuredId);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Branch daemon started");
      expect(result.spawned).toBe(true);
      expect(result.pidWritten).toBe(true);
    });
  }
});
