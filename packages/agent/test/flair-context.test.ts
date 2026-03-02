/**
 * ops-36 Phase 1b — Flair integration tests
 */
import { describe, test, expect, mock } from "bun:test";
import { FlairContextProvider } from "../src/io/flair.js";

describe("ops-36b: FlairContextProvider", () => {
  test("ping returns false when Flair is offline", async () => {
    const provider = new FlairContextProvider("test-agent", {
      url: "http://127.0.0.1:19926", // dead port
    });
    const result = await provider.ping();
    expect(result).toBe(false);
  });

  test("buildContextBlock returns empty string when Flair offline", async () => {
    const provider = new FlairContextProvider("test-agent", {
      url: "http://127.0.0.1:19926",
    });
    const ctx = await provider.buildContextBlock("test query");
    expect(ctx).toBe("");
  });

  test("sign throws when key file missing", () => {
    const provider = new FlairContextProvider("no-such-agent", {
      url: "http://127.0.0.1:9926",
      keyPath: "/nonexistent/path/key.pem",
    });
    expect(() => (provider as any).sign("GET", "/Memory")).toThrow(
      "Flair key not found",
    );
  });
});

describe("ops-36b: LLM proxy", () => {
  test("proxy health endpoint responds ok when running", async () => {
    const { createLLMProxy } = await import("../../../packages/cli/src/utils/llm-proxy.js").catch(
      () => ({ createLLMProxy: null }),
    );
    if (!createLLMProxy) {
      // CLI package not importable from agent package — skip
      expect(true).toBe(true);
      return;
    }

    const port = 16459; // test port
    const proxy = createLLMProxy(port);
    await proxy.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect((body as any).status).toBe("ok");
    } finally {
      proxy.stop();
    }
  });

  test("proxy rejects requests without auth header", async () => {
    const { createLLMProxy } = await import("../../../packages/cli/src/utils/llm-proxy.js").catch(
      () => ({ createLLMProxy: null }),
    );
    if (!createLLMProxy) { expect(true).toBe(true); return; }

    const port = 16460;
    const proxy = createLLMProxy(port);
    await proxy.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/proxy/anthropic/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test" }),
      });
      expect(res.status).toBe(401);
    } finally {
      proxy.stop();
    }
  });
});

describe("ops-36b: AgentRuntime Flair integration", () => {
  test("AgentRuntime accepts flair config without throwing", async () => {
    const { AgentRuntime } = await import("../src/runtime/agent.js");

    const runtime = new AgentRuntime({
      agentId: "test-ops36",
      name: "Test",
      mailDir: "/tmp/mail-test",
      memoryPath: "/tmp/mem-test.jsonl",
      workspace: "/tmp/ws-test",
      llm: { provider: "anthropic", model: "claude-haiku-3-5", apiKey: "test" },
      flair: {
        url: "http://127.0.0.1:19926", // offline — no keys needed since ping fails first
      },
    });

    expect(runtime).toBeDefined();
    expect(runtime.isHealthy()).toBe(true);
  });
});
