import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../src/runtime/agent.js";
import type { AgentConfig } from "../src/runtime/types.js";

describe("AgentRuntime", () => {
  let tmpDir: string;
  let config: AgentConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-agent-test-"));
    config = {
      agentId: "test-agent",
      name: "Test Agent",
      mailDir: join(tmpDir, "mail"),
      memoryPath: join(tmpDir, "memory.jsonl"),
      contextWindowTokens: 1000,
      llm: { provider: "anthropic", model: "claude-3-haiku-20240307" },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("can be instantiated with a valid config", () => {
    const runtime = new AgentRuntime(config);
    expect(runtime).toBeDefined();
    expect(runtime.config.agentId).toBe("test-agent");
    expect(runtime.config.name).toBe("Test Agent");
  });

  test("start() returns when stop() is called", async () => {
    const runtime = new AgentRuntime(config);

    // Start and stop after 50ms to avoid infinite loop
    const startPromise = runtime.start();
    setTimeout(() => runtime.stop(), 50);
    await startPromise;
    // Just verify it completes without throwing
    expect(true).toBe(true);
  });
});
