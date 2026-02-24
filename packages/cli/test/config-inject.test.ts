import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { injectAgent } from "../src/utils/config-inject.js";

describe("config-inject", () => {
  let tempDir: string;
  let configPath: string;

  const baseConfig = {
    agents: {
      defaults: { workspace: "/tmp/ws" },
      list: [
        { id: "flint", name: "Flint", model: "anthropic/claude-opus-4-6" },
      ],
    },
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tps-inject-"));
    configPath = join(tempDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(baseConfig, null, 2) + "\n");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("injects agent and creates backup", () => {
    const result = injectAgent(configPath, {
      id: "scout",
      name: "Scout",
      workspace: "/tmp/ws-scout",
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("scout");
    expect(existsSync(result.backupPath)).toBe(true);

    // Backup matches original
    const backup = JSON.parse(readFileSync(result.backupPath, "utf-8"));
    expect(backup.agents.list).toHaveLength(1);
    expect(backup.agents.list[0].id).toBe("flint");

    // Config has new agent
    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.agents.list).toHaveLength(2);
    expect(updated.agents.list[1].id).toBe("scout");
    expect(updated.agents.list[1].name).toBe("Scout");
  });

  test("rejects duplicate agent id", () => {
    const result = injectAgent(configPath, {
      id: "flint",
      name: "Flint 2",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");

    // Config unchanged
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.agents.list).toHaveLength(1);
  });

  test("rejects missing config file", () => {
    const result = injectAgent("/nonexistent/path.json", {
      id: "scout",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("rejects invalid JSON config", () => {
    writeFileSync(configPath, "not json{{{");
    const result = injectAgent(configPath, { id: "scout" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  test("preserves existing config structure", () => {
    const richConfig = {
      ...baseConfig,
      gateway: { port: 3000 },
      channels: { discord: { token: "secret" } },
    };
    writeFileSync(configPath, JSON.stringify(richConfig, null, 2) + "\n");

    const result = injectAgent(configPath, { id: "scout", name: "Scout" });
    expect(result.success).toBe(true);

    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.gateway.port).toBe(3000);
    expect(updated.channels.discord.token).toBe("secret");
    expect(updated.agents.list).toHaveLength(2);
  });

  test("creates agents.list if missing", () => {
    writeFileSync(configPath, JSON.stringify({ agents: {} }, null, 2) + "\n");
    const result = injectAgent(configPath, { id: "scout" });

    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(updated.agents.list).toHaveLength(1);
    expect(updated.agents.list[0].id).toBe("scout");
  });
});
