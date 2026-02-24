import type { LLMConfig } from "../runtime/types.js";

export interface CompletionRequest {
  systemPrompt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}

export interface CompletionResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Routes completion requests to the appropriate provider.
 * Supports Anthropic, Google, and local Ollama.
 */
export class ProviderManager {
  constructor(private readonly config: LLMConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    switch (this.config.provider) {
      case "anthropic":
        return this.completeAnthropic(request);
      case "google":
        return this.completeGoogle(request);
      case "ollama":
        return this.completeOllama(request);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  private async completeAnthropic(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: request.maxTokens ?? 2048,
        system: request.systemPrompt,
        messages: request.messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return {
      content: data.content?.[0]?.text ?? "",
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }

  private async completeGoogle(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = this.config.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: request.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        systemInstruction: request.systemPrompt
          ? { parts: [{ text: request.systemPrompt }] }
          : undefined,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const usage = data.usageMetadata ?? {};
    return {
      content: text,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  }

  private async completeOllama(request: CompletionRequest): Promise<CompletionResponse> {
    const baseUrl = this.config.baseUrl ?? "http://localhost:11434";
    const systemMsg = request.systemPrompt
      ? [{ role: "system" as const, content: request.systemPrompt }]
      : [];

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [...systemMsg, ...request.messages],
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return {
      content: data.message?.content ?? "",
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
    };
  }
}
