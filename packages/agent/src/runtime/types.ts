export type ProviderName = "anthropic" | "google" | "openai" | "ollama";

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentConfig {
  /** Agent identifier from tps.yaml */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Maildir root */
  mailDir: string;
  /** JSONL memory file path */
  memoryPath: string;
  /** Workspace root for file tools */
  workspace: string;
  /** LLM provider config */
  llm: LLMConfig;
  /** Optional override personas/system prompt */
  systemPrompt?: string;
  /** Target token context window */
  contextWindowTokens?: number;
  /** Max model output tokens */
  maxTokens?: number;
  /** Tools the runtime should load */
  tools?: Array<"read" | "write" | "edit" | "exec" | "mail">;
  /** Allow-list for exec command binary names */
  execAllowlist?: string[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer" | string;
  content?: string;
  name?: string;
  tool_call_id?: string;
}

export interface CompletionRequest {
  systemPrompt?: string;
  messages: LLMMessage[];
  tools: ToolSpec[];
  toolChoice?: "auto" | "required";
  maxTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompletionResponse {
  content?: string;
  toolCalls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export type AgentState =
  | "idle"
  | "processing"
  | "awaiting_approval"
  | "stopped";
