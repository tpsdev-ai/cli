// Public API for @tpsdev-ai/agent

// Runtime
export { AgentRuntime } from "./runtime/agent.js";
export { EventLoop } from "./runtime/event-loop.js";
export { signedTrustTier } from "./runtime/types.js";
export type {
  AgentConfig,
  LLMConfig,
  AgentState,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
  ToolSpec,
  LLMMessage,
  ToolResult,
  TrustLevel,
} from "./runtime/types.js";

// I/O
export { MailClient } from "./io/mail.js";
export type { MailMessage } from "./io/mail.js";
export { MemoryStore } from "./io/memory.js";
export type { MemoryEvent } from "./io/memory.js";
export { ContextManager } from "./io/context.js";

// LLM
export { ProviderManager } from "./llm/provider.js";

// Tools
export { ToolRegistry } from "./tools/registry.js";
export type { Tool } from "./tools/registry.js";
export { createDefaultToolset } from "./tools/index.js";

// Governance
export { BoundaryManager } from "./governance/boundary.js";
export { ReviewGate } from "./governance/review-gate.js";

// Config
export { loadAgentConfig } from "./config.js";

// Flair integration
export { FlairContextProvider } from "./io/flair.js";
export type { FlairConfig } from "./runtime/types.js";

// Signing
export { signEnvelope, verifyEnvelope } from "./lib/signEnvelope.js";
export type { Envelope, ChainEntry, FlairClient, VerifyOk, VerifyReject } from "./lib/signEnvelope.js";
export { parseFlairPublicKey, PublicKeyFormatError } from "./lib/public-key.js";

// Mailbox policy (cli#380)
export {
  ENVELOPE_ID_SHAPE, ENVELOPE_ID_SHAPE_TEXT, isValidEnvelopeId, tryParseEnvelope, parseSignedEnvelope,
  decideEnvelopeForMailbox, isTopicRecipient, mailboxReplayStore, peekConsumedForMailboxRoot, hasCommittedMessageId,
  inspectCurRecord, placeCurRecord,
} from "./lib/mailbox-policy.js";
export type { MailboxPolicyRejectClass, MailboxPolicyResult, ReplayStore, FirstDelivery } from "./lib/mailbox-policy.js";
export { acquireMailLock, acquireMailLockSync, MAIL_LOCK_DIR, mailLockPath, processStartToken } from "./lib/mail-lock.js";
export type { MailLock } from "./lib/mail-lock.js";
export {
  KeyFormatError, AgentKeyError, AgentKeyConflictError,
  agentKeyCandidates, existingAgentKeyPaths, resolveAgentKeyPath,
  readAgentPrivateKey, readPrivateKeyAtPath, toEd25519Seed,
} from "./lib/agent-keys.js";

export { decodeRegistryPublicKey } from "./lib/registry-key.js";
export { BRIDGE_ADAPTERS, resolveBridgeAgentId, configureBridgeIdentity, bridgePrincipalIds, verifiedMailTier } from "./lib/bridge-identity.js";
