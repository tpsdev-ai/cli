import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");


describe("status / heartbeat commands", () => {
  let tmpRoot: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "tps-status-test-"));
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tmpRoot;

    const fakeBin = join(tmpRoot, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash
if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  echo "gateway: ok"
  exit 0
fi
exit 0
`,
      "utf-8"
    );
    chmodSync(join(fakeBin, "openclaw"), 0o755);

    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPath) process.env.PATH = originalPath;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function run(args: string[]) {
    return spawnSync("bun", [TPS_BIN, ...args], {
      cwd: tmpRoot,
      encoding: "utf-8",
      env: process.env,
    });
  }

  test("heartbeat writes node status and status command surfaces it", () => {
    const agent = "tracker-1";
    const workspace = join(tmpRoot, ".tps", "branch-office", agent);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, "mail", "inbox", "new"), { recursive: true });

    const hb = run(["heartbeat", agent]);
    expect(hb.status).toBe(0);
    expect(hb.stdout).toContain(`Heartbeat for ${agent}: online`);

    const statusFile = join(tmpRoot, ".tps", "status", "nodes", `${agent}.json`);
    expect(existsSync(statusFile)).toBe(true);
    const payload = JSON.parse(readFileSync(statusFile, "utf-8"));
    expect(payload.agentId).toBe(agent);

    const st = run(["status", agent, "--json"]);
    expect(st.status).toBe(0);
    const parsed = JSON.parse(st.stdout);
    expect(parsed.agentId).toBe(agent);
    expect(parsed.derivedState).toBeDefined();
  });

  test("status list emits table and auto-prune rotates old entries", () => {
    const agentA = "alice";
    const agentB = "bob";

    const wsA = join(tmpRoot, ".tps", "branch-office", agentA);
    const wsB = join(tmpRoot, ".tps", "branch-office", agentB);
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    mkdirSync(join(wsA, "mail", "inbox", "new"), { recursive: true });
    mkdirSync(join(wsB, "mail", "inbox", "new"), { recursive: true });

    const oldFileA = join(tmpRoot, ".tps", "status", "nodes", `${agentA}.json`);
    const oldFileB = join(tmpRoot, ".tps", "status", "nodes", `${agentB}.json`);
    mkdirSync(join(tmpRoot, ".tps", "status", "nodes"), { recursive: true });
    const staleTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(oldFileA, JSON.stringify({
      agentId: agentA,
      host: "host",
      model: "m",
      status: "offline",
      lastHeartbeat: staleTs,
      lastActivity: staleTs,
      sessionCount: 1,
      errorCount: 0,
      uptime: 12,
      version: "1",
      pid: 1,
      heartbeatHistory: [],
    }, null, 2));
    writeFileSync(oldFileB, JSON.stringify({
      agentId: agentB,
      host: "host",
      model: "m",
      status: "online",
      lastHeartbeat: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      sessionCount: 1,
      errorCount: 0,
      uptime: 12,
      version: "1",
      pid: process.pid,
      heartbeatHistory: [],
    }, null, 2));

    const stList = run(["status"]);
    expect(stList.status).toBe(0);
    expect(stList.stdout).toContain("agent");
    expect(stList.stdout).toContain(agentA);
    expect(stList.stdout).toContain(agentB);

    const prune = run(["status", "--auto-prune"]);
    expect(prune.status).toBe(0);

    // stale entry should be moved into archive
    const archive = join(tmpRoot, ".tps", "status", "archive", `${agentA}.json`);
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(oldFileB)).toBe(true);
  });

  test("heartbeat status command returns cost summary with injected usage", () => {
    const agent = "costly";
    const workspace = join(tmpRoot, ".tps", "branch-office", agent);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, "mail", "inbox", "new"), { recursive: true });
    const hb = run(["heartbeat", agent]);
    expect(hb.status).toBe(0);

    const usagePath = join(tmpRoot, ".tps", "status", "nodes", agent, "usage.jsonl");
    mkdirSync(join(tmpRoot, ".tps", "status", "nodes", agent), { recursive: true });
    appendFileSync(
      usagePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 10,
        outputTokens: 20,
        estimatedCostUsd: 0.002,
      })}\n`,
      "utf-8"
    );

    const st = run(["status", agent, "--cost"]);
    expect(st.status).toBe(0);
    const payload = JSON.parse(st.stdout);
    expect(payload.usage).toBeDefined();
    expect(payload.usage.today).toBeGreaterThan(0);
  });
});
