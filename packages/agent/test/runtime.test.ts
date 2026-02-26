import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentRuntime } from "../src/runtime/agent.js";
import type { AgentConfig } from "../src/runtime/types.js";
import { makeEditTool, makeExecTool } from "../src/tools/index.js";

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
      workspace: tmpDir,
      contextWindowTokens: 1000,
      llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "x" },
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

    const startPromise = runtime.start();
    setTimeout(() => runtime.stop(), 50);
    await startPromise;
    expect(runtime.getState()).toBe("stopped");
  });

  test("edit tool fails on ambiguous replacements", async () => {
    const tool = makeEditTool({ resolveWorkspacePath: (p: string) => join(tmpDir, p) } as any);
    const file = join(tmpDir, "sample.txt");
    writeFileSync(file, "dup dup", "utf-8");
    const out = await tool.execute({ path: "sample.txt", old_string: "dup", new_string: "x" } as any);
    expect(out.isError).toBe(true);
  });

  test("exec tool preserves no shell injection via args array", async () => {
    const tool = makeExecTool({
      resolveWorkspacePath: (p: string) => join(tmpDir, p),
      validateCommand: () => undefined,
      scrubEnvironment: () => ({ PATH: process.env.PATH }),
    } as any, ["git"]);

    const result = await tool.execute({ command: "git", args: ["--version"] } as any);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("git version");
  });
});
