# @tpsdev-ai/agent

> Native TPS Agent Runtime — headless, mail-driven, sandbox-ready.

The runtime library for building AI agents that run inside [TPS](https://github.com/tpsdev-ai/cli) branch offices. Provides the core primitives: event loop, mail I/O, memory, LLM provider management, tool registry, and governance boundaries.

## Install

```bash
npm install @tpsdev-ai/agent
```

## What's Inside

| Module | Description |
|--------|-------------|
| `AgentRuntime` | Main lifecycle manager — boot, run, shutdown |
| `EventLoop` | Mail-driven event processing with backpressure |
| `MailClient` | Async Maildir-based messaging (send/receive/queue) |
| `MemoryStore` | Append-only memory with tail-read and size caps |
| `ContextManager` | Workspace context injection and brief generation |
| `ProviderManager` | Multi-provider LLM access (Anthropic, OpenAI, Google, Ollama) |
| `ToolRegistry` | Capability registration with boundary enforcement |
| `BoundaryManager` | Sandbox permission checks — filesystem, network, exec |
| `ReviewGate` | Human-in-the-loop approval for sensitive operations |

## Quick Example

```typescript
import { AgentRuntime, MailClient, MemoryStore } from "@tpsdev-ai/agent";

const runtime = new AgentRuntime({
  agentId: "researcher",
  workspace: "/home/researcher/.tps",
  provider: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
});

await runtime.boot();
await runtime.run(); // starts the mail-driven event loop
```

## Design Principles

- **Mail-driven, not chat-driven.** Agents communicate through persistent async mail, not ephemeral conversations.
- **Sandbox-first.** Every operation checks boundaries before executing. Works with `nono` profiles and Docker isolation.
- **No shared memory.** Agents are isolated by default. Coordination happens through mail and git, not shared state.

## Used By

- [`@tpsdev-ai/cli`](https://www.npmjs.com/package/@tpsdev-ai/cli) — the TPS command-line interface

## License

Apache-2.0
