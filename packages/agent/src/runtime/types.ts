export type ProviderName = "anthropic" | "claude-oauth" | "google" | "openai" | "openai-oauth" | "ollama";

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  auth?: "oauth" | "api-key";
  apiKey?: string;
  baseUrl?: string;
  /** Localhost LLM proxy URL. When set, all provider calls route through the proxy. */
  proxyUrl?: string;
}

export type TrustLevel = "user" | "internal" | "external";

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
  /** Max tool turns per message (default 12) */
  maxToolTurns?: number;
  /** Tools the runtime should load */
  tools?: Array<"read" | "write" | "edit" | "exec" | "mail">;
  /** Allow-list for exec command binary names */
  execAllowlist?: string[];
  /** Optional Flair memory/identity integration */
  flair?: FlairConfig;
  /** Declarative runtime role */
  role?: "reviewer" | "implementer" | "strategist" | "coordinator";
  /** Role-specific config blob */
  roleConfig?: Record<string, unknown>;
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
  /** Raw provider-specific message (for assistant messages with tool_use blocks) */
  _raw?: unknown;
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
  /** Anthropic/Google/OpenAI cache read tokens */
  cacheReadTokens?: number;
  /** Anthropic cache creation tokens */
  cacheWriteTokens?: number;
  /** Raw assistant message for history accumulation (provider-specific shape) */
  rawAssistantMessage?: unknown;
}

export type AgentState =
  | "idle"
  | "processing"
  | "awaiting_approval"
  | "stopped";


// ─── Flair Integration ───────────────────────────────────────────────────────

export interface FlairConfig {
  /** Base URL for the Flair/Harper API. Default: http://127.0.0.1:9926 */
  url?: string;
  /** Path to Ed25519 private key PEM. Default: ~/.tps/identity/<agentId>.key */
  keyPath?: string;
}
