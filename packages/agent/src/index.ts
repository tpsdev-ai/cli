// Public API for @tpsdev-ai/agent

// Runtime
export { AgentRuntime } from "./runtime/agent.js";
export { EventLoop } from "./runtime/event-loop.js";
export type { AgentConfig, LLMConfig, AgentState } from "./runtime/types.js";

// I/O
export { MailClient } from "./io/mail.js";
export type { MailMessage } from "./io/mail.js";
export { MemoryStore } from "./io/memory.js";
export type { MemoryEvent } from "./io/memory.js";
export { ContextManager } from "./io/context.js";

// LLM
export { ProviderManager } from "./llm/provider.js";
export type { CompletionRequest, CompletionResponse } from "./llm/provider.js";

// Tools
export { ToolRegistry } from "./tools/registry.js";
export type { Tool } from "./tools/registry.js";

// Governance
export { BoundaryManager } from "./governance/boundary.js";
export { ReviewGate } from "./governance/review-gate.js";
