import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  readOpenClawConfig,
  getAgentList,
  getDefaults,
  resolveWorkspace,
  findOpenClawConfig,
  resolveConfigPath,
} from "../src/utils/config.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const CONFIG_PATH = join(FIXTURES, "openclaw-config.json");

describe("readOpenClawConfig", () => {
  test("reads and parses config file", () => {
    const config = readOpenClawConfig(CONFIG_PATH);
    expect(config.agents).toBeDefined();
    expect(config.agents!.list).toBeDefined();
    expect(config.agents!.list!.length).toBe(3);
  });
});

describe("getAgentList", () => {
  test("returns agents from config", () => {
    const config = readOpenClawConfig(CONFIG_PATH);
    const agents = getAgentList(config);
    expect(agents.length).toBe(3);
    expect(agents[0]!.id).toBe("flint");
    expect(agents[1]!.id).toBe("anvil");
  });

  test("returns empty array when no agents", () => {
    const agents = getAgentList({});
    expect(agents).toEqual([]);
  });
});

describe("getDefaults", () => {
  test("returns defaults from config", () => {
    const config = readOpenClawConfig(CONFIG_PATH);
    const defaults = getDefaults(config);
    expect(defaults.workspace).toBe("/tmp/tps-test-default-workspace");
  });

  test("returns empty object when no defaults", () => {
    const defaults = getDefaults({});
    expect(defaults).toEqual({});
  });
});

describe("resolveWorkspace", () => {
  test("uses agent workspace when set", () => {
    const config = readOpenClawConfig(CONFIG_PATH);
    const agents = getAgentList(config);
    const ws = resolveWorkspace(agents[0]!, config);
    expect(ws).toBe("/tmp/tps-test-flint-workspace");
  });

  test("falls back to defaults workspace", () => {
    const config = readOpenClawConfig(CONFIG_PATH);
    const agents = getAgentList(config);
    const noWsAgent = agents.find((a) => a.id === "no-workspace")!;
    const ws = resolveWorkspace(noWsAgent, config);
    expect(ws).toBe("/tmp/tps-test-default-workspace");
  });
});

describe("resolveConfigPath", () => {
  test("returns explicit path when valid", () => {
    const result = resolveConfigPath(CONFIG_PATH);
    expect(result).toBe(CONFIG_PATH);
  });

  test("throws for nonexistent explicit path", () => {
    expect(() => resolveConfigPath("/tmp/nonexistent-config.json")).toThrow(
      /not found/i
    );
  });
});

describe("findOpenClawConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds openclaw.json in directory", () => {
    writeFileSync(join(tmpDir, "openclaw.json"), "{}");
    const found = findOpenClawConfig(tmpDir);
    expect(found).toBe(join(tmpDir, "openclaw.json"));
  });

  test("finds .openclaw/openclaw.json in directory", () => {
    mkdirSync(join(tmpDir, ".openclaw"));
    writeFileSync(join(tmpDir, ".openclaw", "openclaw.json"), "{}");
    const found = findOpenClawConfig(tmpDir);
    expect(found).toBe(join(tmpDir, ".openclaw", "openclaw.json"));
  });

  test("returns null when no config exists", () => {
    // Use a deeply nested tmp dir that won't have openclaw.json in parents
    const deepDir = join(tmpDir, "a", "b", "c");
    mkdirSync(deepDir, { recursive: true });
    // Override HOME to avoid finding real config
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const found = findOpenClawConfig(deepDir);
      // Should either be null or find the real global config
      // Since we set HOME to tmpDir which has no config, should be null
      expect(found).toBeNull();
    } finally {
      process.env.HOME = origHome;
    }
  });
});
