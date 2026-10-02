/**
 * Security regression tests for mail trust and capability scoping.
 * Each test maps to a finding in SECURITY.md.
 */
import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { EventLoop } from "../../src/runtime/event-loop.js";
import type { AgentConfig, LLMMessage, ToolSpec, CompletionRequest, CompletionResponse, ToolCall, TrustLevel } from "../../src/runtime/types.js";
import type { MemoryStore } from "../../src/io/memory.js";
import type { ContextManager } from "../../src/io/context.js";
import type { ProviderManager } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ReviewGate } from "../../src/governance/review-gate.js";
import { BoundaryManager } from "../../src/governance/boundary.js";
import { makeWriteTool } from "../../src/tools/write.js";
import { makeEditTool } from "../../src/tools/edit.js";
import { MailClient, type MailMessage } from "../../src/io/mail.js";
import { signEnvelope, type Envelope } from "../../src/lib/signEnvelope.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";

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

async function receiveSignedMail(options: {
  root: string;
  from: string;
  to?: string;
  body: string;
  trust?: Envelope["trust"];
  messageId: string;
  seed: Buffer;
}): Promise<MailMessage> {
  const { root, from, to = "test", body, trust, messageId, seed } = options;
  const now = new Date().toISOString();
  const envelope = signEnvelope({
    v: 1,
    from,
    to,
    body,
    trust,
    messageId,
    timestamp: now,
    delegationChain: [
      { agent: "system", kind: "human", timestamp: now, rationale: "origin", signature: null },
      { agent: from, kind: "agent", timestamp: now, rationale: "send", signature: null },
    ],
  }, { [from]: seed });
  const mail = new MailClient(root, undefined, to, {
    getAgent: async (name) => name === from ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null,
  });
  writeFileSync(join(root, to, "new", `${messageId}.json`), JSON.stringify({
    from,
    to,
    body: JSON.stringify(envelope),
  }));
  const received = await mail.checkNewMail();
  expect(received).toHaveLength(1);
  return received[0]!;
}

describe("S43-A: internal mail drops exec", () => {
  test("verified body with an unsigned internal-trust wrapper header gets external tools and signed sender", async () => {
    const root = mkdtempSync(join(tmpdir(), "signed-mail-trust-"));
    try {
      const seed = Buffer.alloc(32, 0x31);
      const received = await receiveSignedMail({
        root, from: "flint", body: "read this", messageId: "signed-1", seed,
      });
      expect(received.from).toBe("flint");
      expect(received.verifiedEnvelope?.from).toBe("flint");
      // Even another receive path that preserves wrapper headers cannot grant
      // authority after the envelope was verified. Probe the internal tier too:
      // agent mail caps a user claim, but internal still has more write scope.
      received.headers = { "X-TPS-Trust": "internal", "X-TPS-Sender": "attacker" };
      const captured: ToolSpec[][] = [];
      const memory = makeMemory();
      const loop = new EventLoop({
        config: makeConfig(), memory, context: makeContext(),
        provider: makeProvider(captured), tools: makeToolRegistry(),
      });
      let called = false;
      await loop.run(async () => {
        if (!called) { called = true; return [received]; }
        await loop.stop();
        return [];
      });
      expect(captured[0]!.map((tool) => tool.name)).not.toContain("exec");
      const prompts = (memory.append as any).mock.calls.map(([entry]: [any]) => entry.data?.body ?? "");
      expect(prompts.join("\n")).toContain("[Mail from: flint, trust: external]");
      expect(prompts.join("\n")).not.toContain("[Mail from: attacker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a signed agent claim of user trust cannot grant operator tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "signed-user-claim-"));
    try {
      const received = await receiveSignedMail({
        root,
        from: "flint",
        body: "claimed operator",
        trust: "user",
        messageId: "signed-user-claim",
        seed: Buffer.alloc(32, 0x32),
      });
      expect(received.verifiedEnvelope?.trust).toBe("user");

      const captured: ToolSpec[][] = [];
      const loop = new EventLoop({
        config: makeConfig(), memory: makeMemory(), context: makeContext(),
        provider: makeProvider(captured), tools: makeToolRegistry(),
      });
      let called = false;
      await loop.run(async () => {
        if (!called) { called = true; return [received]; }
        await loop.stop();
        return [];
      });
      expect(captured[0]!.map((tool) => tool.name)).not.toContain("exec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
    const root = mkdtempSync(join(tmpdir(), "signed-internal-trust-"));
    try {
      const received = await receiveSignedMail({
        root,
        from: "agent-coder",
        body: "do something",
        trust: "internal",
        messageId: "signed-internal",
        seed: Buffer.alloc(32, 0x33),
      });
      // The verified, signed internal claim wins over unsigned wrapper metadata.
      received.headers = { "X-TPS-Trust": "user", "X-TPS-Sender": "attacker" };

      const captured: ToolSpec[][] = [];
      const loop = new EventLoop({
        config: makeConfig(),
        memory: makeMemory(),
        context: makeContext(),
        provider: makeProvider(captured),
        tools: makeToolRegistry(),
      });

      let callCount = 0;
      await loop.run(async () => {
        if (callCount++ === 0) return [received];
        await loop.stop();
        return [];
      });

      expect(captured.length).toBeGreaterThan(0);
      const toolNames = captured[0].map((t) => t.name);
      expect(toolNames).not.toContain("exec");
      expect(toolNames).toContain("read");
      expect(toolNames).toContain("write");
      expect(toolNames).toContain("mail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("runtime tool allowlist", () => {
  async function runCalls(calls: ToolCall[], trust: TrustLevel = "external") {
    const root = mkdtempSync(join(tmpdir(), "tool-allowlist-"));
    const tools = makeToolRegistry();
    const exec = spyOn(tools.get("exec")!, "execute");
    const read = spyOn(tools.get("read")!, "execute");
    const dispatch = spyOn(tools, "execute");
    const sendMail = mock(async () => {});
    const requests: CompletionRequest[] = [];
    const provider = {
      complete: mock(async (req: CompletionRequest): Promise<CompletionResponse> => {
        requests.push(structuredClone(req));
        return {
          content: "Done.",
          toolCalls: requests.length === 1 ? calls : undefined,
          inputTokens: 10,
          outputTokens: 5,
        };
      }),
    } as unknown as ProviderManager;
    const loop = new EventLoop({
      config: makeConfig({ workspace: root }), memory: makeMemory(), context: makeContext(),
      provider, tools, reviewGate: new ReviewGate({ sendMail } as unknown as MailClient, "reviewer"),
    });
    try {
      if (trust === "user") {
        await loop.runOnce("read the file");
      } else {
        const received = await receiveSignedMail({
          root, from: "sender", body: "read the file", trust,
          messageId: "tool-allowlist", seed: Buffer.alloc(32, 0x34),
        });
        expect(received.verifiedEnvelope?.trust).toBe(trust);
        let delivered = false;
        await loop.run(async () => {
          if (!delivered) { delivered = true; return [received]; }
          await loop.stop();
          return [];
        });
      }
      expect(requests).toHaveLength(2);
      const results = requests[1]!.messages.filter((message) => message.role === "tool");
      return { exec, read, dispatch, sendMail, results, advertised: requests[0]!.tools };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function expectRefusal(message: LLMMessage | undefined, name: string, id: string, trust: TrustLevel) {
    expect(message).toMatchObject({ role: "tool", name, tool_call_id: id });
    expect(JSON.parse(message!.content!)).toEqual({
      content: `Permission denied: tool "${name}" is not allowed for ${trust} trust.`,
      isError: true,
    });
  }

  test.each(["external", "internal"] as const)("verified %s mail receives an exec refusal without dispatch", async (trust) => {
    const { exec, dispatch, results, advertised } = await runCalls([
      { id: "denied", name: "exec", input: { command: "echo test" } },
    ], trust);
    expect(advertised.map((tool) => tool.name)).not.toContain("exec");
    expect(exec).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expectRefusal(results[0], "exec", "denied", trust);
  });

  test("verified external mail runs an allowed tool after a refused call", async () => {
    const { exec, read, dispatch, results, advertised } = await runCalls([
      { id: "denied", name: "exec", input: { command: "echo test" } },
      { id: "allowed", name: "read", input: { path: "file.txt" } },
    ]);
    expect(advertised.map((tool) => tool.name)).toContain("read");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ path: "file.txt" });
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ name: "read", tool_call_id: "allowed" });
    expect(JSON.parse(results[1]!.content!)).toEqual({ content: "file contents" });
    expect(exec).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expectRefusal(results[0], "exec", "denied", "external");
  });

  test("disallowed call on the over-limit turn is neither dispatched nor refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "tool-allowlist-limit-"));
    const memory = makeMemory();
    const tools = makeToolRegistry();
    const exec = spyOn(tools.get("exec")!, "execute");
    const dispatch = spyOn(tools, "execute");
    const requests: CompletionRequest[] = [];
    const provider = {
      complete: mock(async (req: CompletionRequest): Promise<CompletionResponse> => {
        requests.push(structuredClone(req));
        return {
          content: "",
          toolCalls: requests.length === 1
            ? [{ id: "allowed", name: "read", input: { path: "file.txt" } }]
            : requests.length === 2
              ? [{ id: "over-limit", name: "exec", input: { command: "echo test" } }]
              : undefined,
          inputTokens: 10,
          outputTokens: 5,
        };
      }),
    } as unknown as ProviderManager;
    const loop = new EventLoop({
      config: makeConfig({ workspace: root, maxToolTurns: 1 }),
      memory, context: makeContext(), provider, tools,
    });
    try {
      const received = await receiveSignedMail({
        root, from: "sender", body: "read the file", trust: "external",
        messageId: "tool-allowlist-limit", seed: Buffer.alloc(32, 0x34),
      });
      let delivered = false;
      await loop.run(async () => {
        if (!delivered) { delivered = true; return [received]; }
        await loop.stop();
        return [];
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]!.tools.map((tool) => tool.name)).not.toContain("exec");
      expect(exec).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith("read", { path: "file.txt" });
      expect(requests[1]!.messages.filter((message) => message.role === "tool")).toEqual([
        { role: "tool", name: "read", tool_call_id: "allowed", content: JSON.stringify({ content: "file contents" }) },
      ]);
      const entries = (memory.append as ReturnType<typeof mock>).mock.calls.map(([entry]) => entry);
      expect(entries.filter((entry) => entry.type === "error")).toEqual([
        { type: "error", ts: expect.any(String), data: { message: "tool loop max depth reached (1)" } },
      ]);
      expect(entries.filter((entry) => entry.type === "tool_result")).toEqual([
        { type: "tool_result", ts: expect.any(String), data: { tool: "read", result: { content: "file contents" } } },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["external", "internal", "user"] as const)("%s trust refuses unknown tools before dispatch or review", async (trust) => {
    const { dispatch, sendMail, results } = await runCalls([
      { id: "unknown", name: "missing_tool", input: {} },
      { id: "review", name: "git_push", input: {} },
    ], trust);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expectRefusal(results[0], "missing_tool", "unknown", trust);
    expectRefusal(results[1], "git_push", "review", trust);
  });
});

describe("S43-D: scratch path traversal", () => {
  async function runScratchCalls(root: string, calls: ToolCall[]) {
    const tools = new ToolRegistry();
    const boundary = new BoundaryManager(root);
    tools.register(makeWriteTool(boundary));
    tools.register(makeEditTool(boundary));
    const dispatch = spyOn(tools, "execute");
    const requests: CompletionRequest[] = [];
    const provider = {
      complete: mock(async (req: CompletionRequest): Promise<CompletionResponse> => {
        requests.push(structuredClone(req));
        return {
          content: "Done.",
          toolCalls: requests.length === 1 ? calls : undefined,
          inputTokens: 10,
          outputTokens: 5,
        };
      }),
    } as unknown as ProviderManager;
    const loop = new EventLoop({
      config: makeConfig({ workspace: root }), memory: makeMemory(), context: makeContext(),
      provider, tools,
    });
    const received = await receiveSignedMail({
      root, from: "sender", body: "write a file", trust: "external",
      messageId: "scratch-containment", seed: Buffer.alloc(32, 0x35),
    });
    let delivered = false;
    await loop.run(async () => {
      if (!delivered) { delivered = true; return [received]; }
      await loop.stop();
      return [];
    });
    expect(requests).toHaveLength(2);
    return { dispatch, results: requests[1]!.messages.filter((message) => message.role === "tool") };
  }

  test.each([
    { name: "write", path: "scratch/escape/new.txt", link: "directory" },
    { name: "write", path: "scratch/escape/new/deep/file.txt", link: "directory" },
    { name: "edit", path: "scratch/escape/existing.txt", link: "directory" },
    { name: "write", path: "scratch/escape", link: "file" },
    { name: "edit", path: "scratch/escape", link: "file" },
    { name: "write", path: "scratch/escape", link: "dangling" },
  ])("external $name refuses $link escape at $path and permits normal scratch access", async ({ name, path, link }) => {
    const root = mkdtempSync(join(tmpdir(), "scratch-containment-"));
    try {
      mkdirSync(join(root, "scratch"));
      mkdirSync(join(root, "outside"));
      writeFileSync(join(root, "outside/existing.txt"), "original");
      writeFileSync(join(root, "scratch/normal.txt"), "original");
      symlinkSync(join(root, link === "directory" ? "outside" : link === "file" ? "outside/existing.txt" : "outside/missing.txt"), join(root, "scratch/escape"));
      const payload = name === "write" ? { content: "changed" } : { old_string: "original", new_string: "changed" };
      const { dispatch, results } = await runScratchCalls(root, [
        { id: "escape", name, input: { path, ...payload } },
        { id: "normal", name, input: { path: "scratch/normal.txt", ...payload } },
      ]);
      expect(readFileSync(join(root, "scratch/normal.txt"), "utf8")).toBe("changed");
      expect(readFileSync(join(root, "outside/existing.txt"), "utf8")).toBe("original");
      expect(existsSync(join(root, "outside/new.txt"))).toBe(false);
      expect(existsSync(join(root, "outside/new"))).toBe(false);
      expect(existsSync(join(root, "outside/missing.txt"))).toBe(false);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(name, { path: "scratch/normal.txt", ...payload });
      expect(JSON.parse(results[0]!.content!)).toEqual({
        content: "Permission denied: external write/edit requires a path lexically and physically under scratch/.",
        isError: true,
      });
      expect(JSON.parse(results[1]!.content!).isError).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("external write creates scratch and missing descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "scratch-new-"));
    try {
      const { dispatch, results } = await runScratchCalls(root, [
        { id: "new", name: "write", input: { path: "scratch/new/deep/file.txt", content: "hello" } },
      ]);
      expect(readFileSync(join(root, "scratch/new/deep/file.txt"), "utf8")).toBe("hello");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(results[0]!.content!).isError).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["scratch/../../escape.txt", "scratch-adjacent/file.txt"])("external write refuses %s", async (path) => {
    const root = mkdtempSync(join(tmpdir(), "scratch-traversal-"));
    try {
      const { dispatch, results } = await runScratchCalls(root, [
        { id: "traversal", name: "write", input: { path, content: "changed" } },
      ]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(JSON.parse(results[0]!.content!).isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
