import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const HOME = homedir();
const TEST_ID = "tps-init-test-agent";

afterEach(() => {
  for (const p of [
    join(HOME, ".tps", "identity", `${TEST_ID}.key`),
    join(HOME, ".tps", "identity", `${TEST_ID}.pub`),
    join(HOME, ".tps", "agents", TEST_ID),
    join(HOME, ".tps", "mail", TEST_ID),
    join(HOME, "ops", TEST_ID),
  ]) rmSync(p, { recursive: true, force: true });
});

describe("tps init", () => {
  test("scaffolds identity, config, and workspace", () => {
    const result = spawnSync("bun", [TPS_BIN, "init", "--id", TEST_ID], {
      encoding: "utf-8",
      env: { ...process.env, HOME },  // ensure subprocess uses same HOME
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(HOME, ".tps", "identity", `${TEST_ID}.key`))).toBe(true);
    expect(existsSync(join(HOME, ".tps", "identity", `${TEST_ID}.pub`))).toBe(true);
    expect(existsSync(join(HOME, ".tps", "agents", TEST_ID, "agent.yaml"))).toBe(true);
    expect(existsSync(join(HOME, "ops", TEST_ID, "SOUL.md"))).toBe(true);
  });

  test("errors if agent already exists without --force", () => {
    spawnSync("bun", [TPS_BIN, "init", "--id", TEST_ID], { encoding: "utf-8", env: process.env });
    const result = spawnSync("bun", [TPS_BIN, "init", "--id", TEST_ID], { encoding: "utf-8", env: process.env });
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? "") + (result.stdout ?? "")).toContain("already exists");
  });

  test("--force overwrites existing", () => {
    spawnSync("bun", [TPS_BIN, "init", "--id", TEST_ID], { encoding: "utf-8", env: process.env });
    const result = spawnSync("bun", [TPS_BIN, "init", "--id", TEST_ID, "--force"], { encoding: "utf-8", env: process.env });
    expect(result.status).toBe(0);
  });
});
