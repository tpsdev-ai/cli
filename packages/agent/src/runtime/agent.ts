import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./types.js";
import { EventLoop } from "./event-loop.js";
import { MailClient } from "../io/mail.js";
import { MemoryStore } from "../io/memory.js";
import { ContextManager } from "../io/context.js";
import { ProviderManager } from "../llm/provider.js";
import { BoundaryManager } from "../governance/boundary.js";
import { createDefaultToolset } from "../tools/index.js";
import { EventLogger } from "../telemetry/events.js";

export class AgentRuntime {
  private loop: EventLoop;
  private readonly mail: MailClient;
  private readonly boundary: BoundaryManager;

  constructor(public readonly config: AgentConfig) {
    const events = new EventLogger(
      config.agentId,
      join(config.workspace, ".tps", "events"),
    );
    const mail = new MailClient(config.mailDir, events, config.agentId);
    const memory = new MemoryStore(config.memoryPath);
    const context = new ContextManager(memory, config.contextWindowTokens ?? 8000);
    const provider = new ProviderManager(config.llm, events, config.agentId);

    this.mail = mail;
    this.boundary = new BoundaryManager(config.workspace);
    const tools = createDefaultToolset({
      boundary: this.boundary,
      mail,
      tools: config.tools,
      execAllowlist: config.execAllowlist,
    });

    this.loop = new EventLoop({ config, memory, context, provider, tools, events });
  }

  async start(): Promise<void> {
    const checkInbox = async () => this.mail.checkNewMail();
    const pidPath = join(this.config.workspace, ".tps-agent.pid");
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${process.pid}\n`, "utf-8");

    const shutdown = new Promise<void>((resolve) => {
      const onStop = async () => {
        await this.loop.stop();
        resolve();
      };
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
    });

    try {
      await Promise.race([this.loop.run(checkInbox), shutdown]);
    } finally {
      rmSync(pidPath, { force: true });
    }
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

  isHealthy(): boolean {
    return this.getState() !== "stopped";
  }

  describeBoundaries(): string {
    return this.boundary.describeCapabilities();
  }
}
