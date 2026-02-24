import type { AgentConfig } from "./types.js";
import { EventLoop } from "./event-loop.js";
import { MailClient } from "../io/mail.js";
import { MemoryStore } from "../io/memory.js";
import { ContextManager } from "../io/context.js";
import { ProviderManager } from "../llm/provider.js";

export class AgentRuntime {
  private loop: EventLoop;

  constructor(public readonly config: AgentConfig) {
    const mail = new MailClient(config.mailDir);
    const memory = new MemoryStore(config.memoryPath);
    const context = new ContextManager(memory, config.contextWindowTokens ?? 8_000);
    const provider = new ProviderManager(config.llm);
    this.loop = new EventLoop({ config, mail, memory, context, provider });
  }

  async start(): Promise<void> {
    await this.loop.run();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }
}
