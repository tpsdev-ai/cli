import type { AgentConfig } from "./types.js";
import { EventLoop } from "./event-loop.js";
import { MailClient } from "../io/mail.js";
import { MemoryStore } from "../io/memory.js";
import { ContextManager } from "../io/context.js";
import { ProviderManager } from "../llm/provider.js";
import { BoundaryManager } from "../governance/boundary.js";
import { createDefaultToolset } from "../tools/index.js";

export class AgentRuntime {
  private loop: EventLoop;
  private readonly mail: MailClient;
  private readonly boundary: BoundaryManager;

  constructor(public readonly config: AgentConfig) {
    const mail = new MailClient(config.mailDir);
    const memory = new MemoryStore(config.memoryPath);
    const context = new ContextManager(memory, config.contextWindowTokens ?? 8000);
    const provider = new ProviderManager(config.llm);

    this.mail = mail;
    this.boundary = new BoundaryManager(config.workspace);
    const tools = createDefaultToolset({
      boundary: this.boundary,
      mail,
      tools: config.tools,
      execAllowlist: config.execAllowlist,
    });

    this.loop = new EventLoop({ config, memory, context, provider, tools });
  }

  async start(): Promise<void> {
    const checkInbox = async () => this.mail.checkNewMail();
    await this.loop.run(checkInbox);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  async runOnce(message: string): Promise<void> {
    await this.loop.runOnce(message);
  }

  getState(): string {
    return this.loop.getState();
  }

  describeBoundaries(): string {
    return this.boundary.describeCapabilities();
  }
}
