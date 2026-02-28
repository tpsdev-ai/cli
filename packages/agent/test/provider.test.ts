import { describe, expect, test } from "bun:test";
import { ProviderManager } from "../src/llm/provider.js";

// We test the response mappers by calling complete() with mocked fetch.
// Each provider has a distinct response format — these tests ensure
// tool calls are normalized correctly into { id, name, input }.

function makeProvider(provider: "anthropic" | "openai" | "ollama" | "google") {
  return new ProviderManager({
    provider,
    model: "test-model",
    apiKey: "test-key",
  });
}

// --- Anthropic ---

describe("Anthropic response mapping", () => {
  test("parses tool_use blocks", async () => {
    const pm = makeProvider("anthropic");
    const raw = {
      content: [
        { type: "text", text: "I'll write that file." },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "write",
          input: { path: "hello.txt", content: "Hello!" },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "write", description: "Write a file", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.content).toBe("I'll write that file.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].id).toBe("toolu_123");
    expect(res.toolCalls![0].name).toBe("write");
    expect(res.toolCalls![0].input).toEqual({ path: "hello.txt", content: "Hello!" });
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(50);
  });

  test("handles text-only response (no tools)", async () => {
    const pm = makeProvider("anthropic");
    const raw = {
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("Done.");
    expect(res.toolCalls).toBeUndefined();
  });

  test("handles multiple tool calls", async () => {
    const pm = makeProvider("anthropic");
    const raw = {
      content: [
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
        { type: "tool_use", id: "t2", name: "write", input: { path: "b.txt", content: "hi" } },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls![0].name).toBe("read");
    expect(res.toolCalls![1].name).toBe("write");
  });
});

// --- OpenAI ---

describe("OpenAI response mapping", () => {
  test("parses function tool calls", async () => {
    const pm = makeProvider("openai");
    const raw = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_abc",
                function: {
                  name: "exec",
                  arguments: '{"command":"ls -la"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "exec", description: "Run command", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].id).toBe("call_abc");
    expect(res.toolCalls![0].name).toBe("exec");
    expect(res.toolCalls![0].input).toEqual({ command: "ls -la" });
    expect(res.inputTokens).toBe(200);
    expect(res.outputTokens).toBe(30);
  });

  test("handles text-only response", async () => {
    const pm = makeProvider("openai");
    const raw = {
      choices: [{ message: { content: "All done.", tool_calls: undefined } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("All done.");
    expect(res.toolCalls).toBeUndefined();
  });
});

// --- Ollama ---

describe("Ollama response mapping", () => {
  test("parses function tool calls (object arguments)", async () => {
    const pm = makeProvider("ollama");
    const raw = {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_xyz",
            function: {
              name: "write",
              arguments: { path: "test.txt", content: "hello" },
            },
          },
        ],
      },
      prompt_eval_count: 143,
      eval_count: 100,
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "write", description: "Write a file", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe("write");
    expect(res.toolCalls![0].input).toEqual({ path: "test.txt", content: "hello" });
    expect(res.inputTokens).toBe(143);
    expect(res.outputTokens).toBe(100);
  });

  test("parses function tool calls (string arguments)", async () => {
    const pm = makeProvider("ollama");
    const raw = {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_str",
            function: {
              name: "read",
              arguments: '{"path":"config.yaml"}',
            },
          },
        ],
      },
      prompt_eval_count: 50,
      eval_count: 20,
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe("read");
    expect(res.toolCalls![0].input).toEqual({ path: "config.yaml" });
  });

  test("handles text-only response", async () => {
    const pm = makeProvider("ollama");
    const raw = {
      message: { role: "assistant", content: "File written." },
      prompt_eval_count: 10,
      eval_count: 5,
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("File written.");
    expect(res.toolCalls).toBeUndefined();
  });
});

// --- Google ---

describe("Google response mapping", () => {
  test("parses functionCall parts", async () => {
    const pm = makeProvider("google");
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "write",
                  args: { path: "out.txt", content: "data" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "write", description: "Write", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe("write");
    expect(res.toolCalls![0].input).toEqual({ path: "out.txt", content: "data" });
    expect(res.inputTokens).toBe(80);
    expect(res.outputTokens).toBe(40);
  });

  test("parses text-only response", async () => {
    const pm = makeProvider("google");
    const raw = {
      candidates: [
        {
          content: {
            parts: [{ text: "Here's your answer." }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("Here's your answer.");
    expect(res.toolCalls).toBeUndefined();
  });

  test("handles mixed text + functionCall parts", async () => {
    const pm = makeProvider("google");
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              { text: "Let me check." },
              { functionCall: { name: "read", args: { path: "data.json" } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("Let me check.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe("read");
  });
});

// --- Tool schema formatting ---

describe("Tool schema formatting", () => {
  const spec = {
    name: "write",
    description: "Write a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  };

  test("Anthropic format", () => {
    const pm = makeProvider("anthropic");
    const fn = pm.toolInputSchemaFor("anthropic");
    const result = fn([spec]) as any[];
    expect(result[0].name).toBe("write");
    expect(result[0].input_schema).toBeDefined();
    expect(result[0].function).toBeUndefined();
  });

  test("OpenAI format wraps in function object", () => {
    const pm = makeProvider("openai");
    const fn = pm.toolInputSchemaFor("openai");
    const result = fn([spec]) as any[];
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("write");
    expect(result[0].function.parameters).toBeDefined();
  });

  test("Ollama uses OpenAI format", () => {
    const pm = makeProvider("ollama");
    const fn = pm.toolInputSchemaFor("ollama");
    const result = fn([spec]) as any[];
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("write");
  });

  test("Google format uses functionDeclarations", () => {
    const pm = makeProvider("google");
    const fn = pm.toolInputSchemaFor("google");
    const result = fn([spec]) as any;
    expect(result.functionDeclarations).toHaveLength(1);
    expect(result.functionDeclarations[0].name).toBe("write");
  });
});

// --- Edge cases ---

describe("Edge cases", () => {
  test("safeJson handles malformed string", async () => {
    const pm = makeProvider("openai");
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c1", function: { name: "exec", arguments: "not json{" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.toolCalls![0].input).toEqual({});
  });

  test("handles empty/missing content gracefully", async () => {
    const pm = makeProvider("anthropic");
    const raw = { content: [], usage: {} };

    globalThis.fetch = async () =>
      new Response(JSON.stringify(raw), { status: 200 });

    const res = await pm.complete({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });

    expect(res.content).toBe("");
    expect(res.toolCalls).toBeUndefined();
  });
});


describe("Google OAuth mode", () => {
  test("uses bearer token when auth=oauth", async () => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const authDir = join(process.env.HOME || homedir(), ".tps", "auth");
    const authFile = join(authDir, "google.json");
    mkdirSync(authDir, { recursive: true });

    const hadOriginal = existsSync(authFile);
    const original = hadOriginal ? readFileSync(authFile, "utf-8") : undefined;

    writeFileSync(authFile, JSON.stringify({
      provider: "google",
      refreshToken: "r",
      accessToken: "bearer-1",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
      scopes: "s",
    }));

    const pm = new ProviderManager({ provider: "google", model: "test-model", auth: "oauth" });
    let authHeader = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      authHeader = init?.headers?.Authorization || "";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }), { status: 200 });
    }) as any;

    const res = await pm.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(res.content).toBe("ok");
    expect(authHeader).toBe("Bearer bearer-1");

    if (hadOriginal && original !== undefined) writeFileSync(authFile, original);
    else rmSync(authFile, { force: true });
  });
});
