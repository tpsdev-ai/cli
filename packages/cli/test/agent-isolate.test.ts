import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");

describe("tps agent isolate", () => {
  const testDir = join(homedir(), ".openclaw-isolate-test");

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("errors when agent not found in openclaw.json", () => {
    const result = spawnSync("bun", [TPS_BIN, "agent", "isolate", "--id", "nonexistent-agent-xyz"], {
      encoding: "utf-8",
      env: process.env,
    });
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? "") + (result.stdout ?? "")).toMatch(/not found|OpenClaw config not found/i);
  });

  test("errors when no --id provided", () => {
    const result = spawnSync("bun", [TPS_BIN, "agent", "isolate"], {
      encoding: "utf-8",
      env: process.env,
    });
    expect(result.status).not.toBe(0);
  });
});
