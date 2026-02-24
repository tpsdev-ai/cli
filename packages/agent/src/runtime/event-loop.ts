import type { AgentConfig, AgentState } from "./types.js";
import type { MailClient } from "../io/mail.js";
import type { MemoryStore } from "../io/memory.js";
import type { ContextManager } from "../io/context.js";
import type { ProviderManager } from "../llm/provider.js";

interface EventLoopDeps {
  config: AgentConfig;
  mail: MailClient;
  memory: MemoryStore;
  context: ContextManager;
  provider: ProviderManager;
}

export class EventLoop {
  private state: AgentState = "idle";
  private running = false;

  constructor(private readonly deps: EventLoopDeps) {}

  async run(): Promise<void> {
    this.running = true;
    this.state = "idle";

    while (this.running) {
      const messages = await this.deps.mail.checkNewMail();

      if (messages.length === 0) {
        // No work — sleep briefly before next poll
        await sleep(500);
        continue;
      }

      for (const msg of messages) {
        if (!this.running) break;

        this.state = "processing";

        try {
          await this.processMessage(msg);
        } catch (err) {
          // Log errors to memory and continue rather than crashing the loop
          await this.deps.memory.append({
            type: "error",
            ts: new Date().toISOString(),
            data: String(err),
          });
        }

        this.state = "idle";
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state = "stopped";
  }

  getState(): AgentState {
    return this.state;
  }

  private async processMessage(msg: unknown): Promise<void> {
    // Stub: real implementation builds prompt, calls LLM, handles tool calls
    await this.deps.memory.append({
      type: "message",
      ts: new Date().toISOString(),
      data: msg,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
