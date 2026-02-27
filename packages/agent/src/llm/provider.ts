import type {
  LLMConfig,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
  ToolSpec,
  LLMMessage,
} from "../runtime/types.js";

type ProviderKind = LLMConfig["provider"];

/**
 * Routes completion requests to the configured provider and normalizes
 * tool-call responses into a common shape.
 */
export class ProviderManager {
  constructor(private readonly config: LLMConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    switch (this.config.provider) {
      case "anthropic":
        return this.completeAnthropic(request);
      case "google":
        return this.completeGoogle(request);
      case "openai":
        return this.completeOpenAI(request);
      case "ollama":
        return this.completeOllama(request);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  private toolSetForAnthropic(tools: ToolSpec[]) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private toolSetForOpenAI(tools: ToolSpec[]) {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private toolSetForGoogle(tools: ToolSpec[]) {
    return {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      })),
    };
  }

  private mapAnthropicResponse(raw: any): CompletionResponse {
    const blocks = raw?.content ?? [];
    const toolCalls: ToolCall[] = [];
    let content = "";

    for (const block of blocks) {
      if (block?.type === "tool_use" && block?.name && block?.id) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: typeof block.input === "object" ? block.input : {},
        });
      }
      if (block?.type === "text") {
        content += block.text ?? "";
      }
    }

    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      inputTokens: raw?.usage?.input_tokens ?? 0,
      outputTokens: raw?.usage?.output_tokens ?? 0,
      cacheReadTokens: raw?.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: raw?.usage?.cache_creation_input_tokens ?? 0,
      // Raw assistant message preserves tool_use blocks for history
      rawAssistantMessage: { role: "assistant", content: raw?.content },
    };
  }

  private mapOpenAIResponse(raw: any): CompletionResponse {
    const message = raw?.choices?.[0]?.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((toolCall: any) => ({
      id: toolCall?.id,
      name: toolCall?.function?.name,
      input: this.safeJson(toolCall?.function?.arguments),
    })) as ToolCall[];

    return {
      content: message?.content ?? "",
      toolCalls: toolCalls.length ? toolCalls : undefined,
      inputTokens: raw?.usage?.prompt_tokens ?? 0,
      outputTokens: raw?.usage?.completion_tokens ?? 0,
      cacheReadTokens: raw?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      rawAssistantMessage: message,
    };
  }

  private mapOllamaResponse(raw: any): CompletionResponse {
    const message = raw?.message ?? {};
    let toolCalls: ToolCall[] | undefined;

    if (message?.tool_calls) {
      toolCalls = message.tool_calls.map((toolCall: any) => ({
        id: toolCall?.id,
        name: toolCall?.function?.name,
        input: typeof toolCall?.function?.arguments === "string"
          ? this.safeJson(toolCall.function.arguments)
          : toolCall?.function?.arguments ?? {},
      }));
    }

    return {
      content: message?.content ?? "",
      toolCalls: toolCalls && toolCalls.length ? toolCalls : undefined,
      inputTokens: raw?.prompt_eval_count ?? 0,
      outputTokens: raw?.eval_count ?? 0,
      rawAssistantMessage: message,
    };
  }

  private safeJson(raw: unknown): Record<string, unknown> {
    if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  /** Build messages array, using raw assistant messages when available */
  private buildMessages(messages: LLMMessage[]): any[] {
    return messages.map((m) => {
      if (m.role === "assistant" && m._raw) {
        return m._raw;
      }
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: m.content ?? "",
        };
      }
      return { role: m.role, content: m.content ?? "" };
    });
  }

  private async completeAnthropic(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    // Cache-aware system prompt (multi-block with breakpoint)
    const system = request.systemPrompt
      ? [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } }]
      : undefined;

    // Cache breakpoint on last tool only
    const tools = this.toolSetForAnthropic(request.tools) as any[];
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    // Use raw assistant messages for Anthropic format compliance
    const messages = request.messages.map((m) => {
      if (m.role === "assistant" && m._raw) return m._raw;
      if (m.role === "tool") {
        return {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content ?? "",
          }],
        };
      }
      return { role: m.role, content: m.content ?? "" };
    });

    const body = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? 4096,
      system,
      messages,
      tools,
      tool_choice: request.toolChoice === "required"
        ? { type: "any" }
        : { type: "auto" },
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return this.mapAnthropicResponse(data);
  }

  private async completeGoogle(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = this.config.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${apiKey}`;
    const toolPayload = this.toolSetForGoogle(request.tools);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: request.systemPrompt
          ? { parts: [{ text: request.systemPrompt }] }
          : undefined,
        contents: request.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content ?? "" }],
        })),
        tools: toolPayload,
        toolConfig: request.toolChoice === "required" ? { functionCallingConfig: { mode: "ANY" } } : undefined,
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 2048,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Google API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    const candidate = data?.candidates?.[0] ?? {};
    const functionCalls = candidate?.content?.parts?.flatMap((part: any) => {
      if (Array.isArray(part?.functionCalls)) return part.functionCalls;
      if (part?.functionCall) return [part.functionCall];
      return [];
    }) ?? [];

    const toolCalls = functionCalls.map((toolCall: any) => ({
      id: toolCall?.id,
      name: toolCall?.name,
      input: this.safeJson(toolCall?.args),
    } as ToolCall));

    return {
      content: candidate?.content?.parts?.map((part: any) => part?.text).filter(Boolean).join("\n") ?? "",
      toolCalls: toolCalls.length ? toolCalls : undefined,
      inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      cacheReadTokens: data?.usageMetadata?.cachedContentTokenCount ?? 0,
      rawAssistantMessage: candidate?.content,
    };
  }

  private async completeOpenAI(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        tools: this.toolSetForOpenAI(request.tools),
        tool_choice: request.toolChoice ?? "auto",
        max_tokens: request.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return this.mapOpenAIResponse(data);
  }

  private async completeOllama(request: CompletionRequest): Promise<CompletionResponse> {
    const baseUrl = this.config.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        tools: this.toolSetForOpenAI(request.tools),
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return this.mapOllamaResponse(data);
  }

  public toToolSpec(name: string, description: string, inputSchema: Record<string, unknown>): ToolSpec {
    return {
      name,
      description,
      input_schema: {
        type: "object",
        properties: inputSchema,
        additionalProperties: false,
      },
    };
  }

  public toolInputSchemaFor(provider: ProviderKind): (schema: ToolSpec[]) => unknown {
    if (provider === "openai" || provider === "ollama") return this.toolSetForOpenAI.bind(this);
    if (provider === "google") return this.toolSetForGoogle.bind(this);
    return this.toolSetForAnthropic.bind(this);
  }
}
