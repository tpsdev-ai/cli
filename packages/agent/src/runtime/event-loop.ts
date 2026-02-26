import type { MailMessage } from "../io/mail.js";
import type { AgentConfig, CompletionRequest, ToolCall, ToolSpec, AgentState } from "./types.js";
import type { MemoryStore } from "../io/memory.js";
import type { ContextManager } from "../io/context.js";
import type { ProviderManager } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ReviewGate } from "../governance/review-gate.js";

interface EventLoopDeps {
  config: AgentConfig;
  memory: MemoryStore;
  context: ContextManager;
  provider: ProviderManager;
  tools: ToolRegistry;
  reviewGate?: ReviewGate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EventLoop {
  private state: AgentState = "idle";
  private running = false;

  constructor(private readonly deps: EventLoopDeps, private readonly pollMs = 500) {}

  async run(checkInbox: () => Promise<MailMessage[]>): Promise<void> {
    this.running = true;
    this.state = "idle";

    while (this.running) {
      const messages = await checkInbox();
      for (const msg of messages) {
        if (!this.running) break;
        this.state = "processing";
        try {
          await this.processMail(msg);
        } catch (err: any) {
          await this.deps.memory.append({
            type: "error",
            ts: new Date().toISOString(),
            data: String(err?.message ?? err),
          });
        }
        this.state = "idle";
      }

      if (!this.running) break;
      if (messages.length === 0) await sleep(this.pollMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state = "stopped";
  }

  getState(): AgentState {
    return this.state;
  }

  async runOnce(prompt: string): Promise<void> {
    await this.processMessage(prompt);
  }

  private async processMail(message: MailMessage): Promise<void> {
    const body = typeof message.body === "string" ? message.body : JSON.stringify(message.body);
    await this.processMessage(body);
  }

  private async processMessage(promptRaw: string): Promise<void> {
    const prompt = String(promptRaw).trim();

    const tools = this.deps.tools
      .list()
      .map<ToolSpec>((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: "object",
          properties: tool.input_schema,
          additionalProperties: false,
        },
      }));

    await this.deps.memory.append({
      type: "message",
      ts: new Date().toISOString(),
      data: { direction: "in", body: prompt },
    });

    let completion = await this.deps.provider.complete({
      systemPrompt: await this.buildSystemPrompt(),
      messages: [{ role: "user", content: prompt }],
      tools,
      toolChoice: "auto",
      maxTokens: this.deps.config.maxTokens ?? 1024,
    });

    let turns = 0;

    while (true) {
      if (completion.content) {
        await this.deps.memory.append({
          type: "assistant",
          ts: new Date().toISOString(),
          data: {
            content: completion.content,
            inputTokens: completion.inputTokens,
            outputTokens: completion.outputTokens,
          },
        });
      }

      if (!completion.toolCalls || completion.toolCalls.length === 0) return;

      if (turns++ > 8) {
        await this.deps.memory.append({
          type: "error",
          ts: new Date().toISOString(),
          data: { message: "tool loop max depth reached" },
        });
        return;
      }

      const toolMessages: Array<{ role: "tool"; tool_call_id: string; name: string; content: string }> = [];
      for (const call of completion.toolCalls ?? []) {
        await this.deps.memory.append({
          type: "tool_call",
          ts: new Date().toISOString(),
          data: { tool: call.name, args: call.input },
        });

        const reviewBlocked = this.deps.reviewGate?.isHighRisk(call.name) ?? false;
        if (reviewBlocked) {
          await this.deps.reviewGate!.requestApproval(call.name, call.input);
          await this.deps.memory.append({
            type: "approval_request",
            ts: new Date().toISOString(),
            data: { tool: call.name, args: call.input },
          });
          continue;
        }

        let result;
        try {
          result = await this.deps.tools.execute(call.name, call.input);
        } catch (err: any) {
          result = { content: `Tool execution error: ${err?.message ?? String(err)}`, isError: true };
        }

        await this.deps.memory.append({
          type: "tool_result",
          ts: new Date().toISOString(),
          data: { tool: call.name, result },
        });

        toolMessages.push({
          role: "tool",
          tool_call_id: String((call as ToolCall).id ?? `${Date.now()}-${Math.random()}`),
          name: call.name,
          content: JSON.stringify(result),
        });
      }

      completion = await this.deps.provider.complete({
        systemPrompt: await this.buildSystemPrompt(),
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: completion.content ?? "" },
          ...toolMessages,
        ] as any,
        tools,
        toolChoice: "auto",
        maxTokens: this.deps.config.maxTokens ?? 1024,
      });
    }
  }

  private async buildSystemPrompt(): Promise<string> {
    const docs = await Promise.all([
      this.fileOrEmpty(`${this.deps.config.workspace}/SOUL.md`),
      this.fileOrEmpty(`${this.deps.config.workspace}/AGENTS.md`),
      this.fileOrEmpty(`${this.deps.config.workspace}/IDENTITY.md`),
      Promise.resolve(this.deps.config.systemPrompt || ""),
    ]);

    const docBlock = docs.filter(Boolean).join("\n\n");
    return [
      docBlock,
      `Role: ${this.deps.config.name}`,
      `Tools: ${this.deps.tools.list().map((t) => t.name).join(", ") || "(none)"}`,
      `Context: ${this.deps.config.agentId}`,
    ].join("\n");
  }

  private async fileOrEmpty(path: string): Promise<string> {
    try {
      const fs = await import("node:fs/promises");
      return await fs.readFile(path, "utf-8");
    } catch {
      return "";
    }
  }
}
