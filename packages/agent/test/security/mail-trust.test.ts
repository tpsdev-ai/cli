/**
 * Security regression tests for mail trust and capability scoping.
 * Each test maps to a finding in SECURITY.md.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { EventLoop } from "../../src/runtime/event-loop.js";
import type { AgentConfig, LLMMessage, ToolSpec, CompletionResponse } from "../../src/runtime/types.js";
import type { MemoryStore } from "../../src/io/memory.js";
import type { ContextManager } from "../../src/io/context.js";
import type { ProviderManager } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    agentId: "test",
    workspace: "/tmp/test-workspace",
    provider: "anthropic",
    model: "test",
    maxToolTurns: 5,
    ...overrides,
  } as AgentConfig;
}

function makeMemory(): MemoryStore {
  return { append: mock(() => Promise.resolve()) } as any;
}

function makeContext(): ContextManager {
  return {} as any;
}

/**
 * Build a provider mock that captures what tools were passed to it.
 */
function makeProvider(capturedTools: ToolSpec[][]): ProviderManager {
  return {
    complete: mock((req: any) => {
      capturedTools.push([...req.tools]);
      return Promise.resolve({
        content: "Done.",
        toolCalls: undefined,
        inputTokens: 10,
        outputTokens: 5,
      } as CompletionResponse);
    }),
  } as any;
}

function makeToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "read",
    description: "Read a file",
    input_schema: { path: { type: "string" } },
    execute: async () => ({ content: "file contents" }),
  });
  reg.register({
    name: "write",
    description: "Write a file",
    input_schema: { path: { type: "string" }, content: { type: "string" } },
    execute: async () => ({ content: "ok" }),
  });
  reg.register({
    name: "edit",
    description: "Edit a file",
    input_schema: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
    execute: async () => ({ content: "ok" }),
  });
  reg.register({
    name: "exec",
    description: "Execute a command",
    input_schema: { command: { type: "string" } },
    execute: async () => ({ content: "output" }),
  });
  reg.register({
    name: "mail",
    description: "Send mail",
    input_schema: { to: { type: "string" }, body: { type: "string" } },
    execute: async () => ({ content: "sent" }),
  });
  return reg;
}

describe("S43-A: internal mail drops exec", () => {
  test("user trust gets exec", async () => {
    const captured: ToolSpec[][] = [];
    const loop = new EventLoop({
      config: makeConfig(),
      memory: makeMemory(),
      context: makeContext(),
      provider: makeProvider(captured),
      tools: makeToolRegistry(),
    });

    await loop.runOnce("hello"); // runOnce uses trust=user
    expect(captured.length).toBeGreaterThan(0);
    const toolNames = captured[0].map((t) => t.name);
    expect(toolNames).toContain("exec");
  });

  test("internal trust does NOT get exec", async () => {
    const captured: ToolSpec[][] = [];
    const loop = new EventLoop({
      config: makeConfig(),
      memory: makeMemory(),
      context: makeContext(),
      provider: makeProvider(captured),
      tools: makeToolRegistry(),
    });

    // Simulate internal mail
    const mail = {
      body: "do something",
      headers: { "X-TPS-Trust": "internal", "X-TPS-Sender": "agent-coder" },
    };

    // Access private processMail via run() with injected inbox
    let callCount = 0;
    await loop.run(async () => {
      if (callCount++ === 0) return [mail as any];
      await loop.stop();
      return [];
    });

    expect(captured.length).toBeGreaterThan(0);
    const toolNames = captured[0].map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("mail");
  });

  test("external trust does NOT get exec", async () => {
    const captured: ToolSpec[][] = [];
    const loop = new EventLoop({
      config: makeConfig(),
      memory: makeMemory(),
      context: makeContext(),
      provider: makeProvider(captured),
      tools: makeToolRegistry(),
    });

    const mail = {
      body: "do something",
      headers: { "X-TPS-Trust": "external", "X-TPS-Sender": "unknown" },
    };

    let callCount = 0;
    await loop.run(async () => {
      if (callCount++ === 0) return [mail as any];
      await loop.stop();
      return [];
    });

    expect(captured.length).toBeGreaterThan(0);
    const toolNames = captured[0].map((t) => t.name);
    expect(toolNames).not.toContain("exec");
  });
});

describe("S43-D: scratch path traversal", () => {
  test("external mail write to scratch/file.txt is allowed", async () => {
    const memory = makeMemory();
    const tools = makeToolRegistry();
    const writeResults: string[] = [];

    // Override write tool to capture calls
    tools.register({
      name: "write",
      description: "Write a file",
      input_schema: { path: { type: "string" }, content: { type: "string" } },
      execute: async (input: any) => {
        writeResults.push(input.path);
        return { content: "ok" };
      },
    });

    const provider = {
      complete: mock(async (req: any) => {
        // First call: request a write to scratch/file.txt
        if ((provider.complete as any).mock.calls.length <= 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "write", input: { path: "scratch/file.txt", content: "hello" } }],
            inputTokens: 10,
            outputTokens: 5,
          };
        }
        return { content: "Done.", toolCalls: undefined, inputTokens: 10, outputTokens: 5 };
      }),
    } as any;

    const loop = new EventLoop({
      config: makeConfig(),
      memory,
      context: makeContext(),
      provider,
      tools,
    });

    const mail = {
      body: "write a file",
      headers: { "X-TPS-Trust": "external", "X-TPS-Sender": "outsider" },
    };

    let callCount = 0;
    await loop.run(async () => {
      if (callCount++ === 0) return [mail as any];
      await loop.stop();
      return [];
    });

    expect(writeResults).toContain("scratch/file.txt");
  });

  test("external mail write to scratch/../../etc/passwd is BLOCKED", async () => {
    const memory = makeMemory();
    const memoryAppendCalls: any[] = [];
    (memory.append as any).mockImplementation((entry: any) => {
      memoryAppendCalls.push(entry);
      return Promise.resolve();
    });

    const provider = {
      complete: mock(async (req: any) => {
        if ((provider.complete as any).mock.calls.length <= 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "write", input: { path: "scratch/../../etc/passwd", content: "pwned" } }],
            inputTokens: 10,
            outputTokens: 5,
          };
        }
        return { content: "Done.", toolCalls: undefined, inputTokens: 10, outputTokens: 5 };
      }),
    } as any;

    const loop = new EventLoop({
      config: makeConfig(),
      memory,
      context: makeContext(),
      provider,
      tools: makeToolRegistry(),
    });

    const mail = {
      body: "write a file",
      headers: { "X-TPS-Trust": "external", "X-TPS-Sender": "attacker" },
    };

    let callCount = 0;
    await loop.run(async () => {
      if (callCount++ === 0) return [mail as any];
      await loop.stop();
      return [];
    });

    // Should have logged a permission denied error
    const denials = memoryAppendCalls.filter(
      (e: any) => e.type === "tool_result" && e.data?.result?.isError,
    );
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0].data.result.content).toContain("Permission denied");
  });
});
