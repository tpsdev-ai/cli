export interface LLMConfig {
  provider: "anthropic" | "google" | "ollama";
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentConfig {
  /** Agent identifier from tps.yaml */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Maildir root: ~/mail/inbox, ~/mail/outbox */
  mailDir: string;
  /** JSONL memory file path */
  memoryPath: string;
  /** Target token context window (for compaction) */
  contextWindowTokens?: number;
  /** LLM provider config */
  llm: LLMConfig;
  /** System prompt override */
  systemPrompt?: string;
}

/** Runtime state machine states */
export type AgentState =
  | "idle"
  | "processing"
  | "awaiting_approval"
  | "stopped";
