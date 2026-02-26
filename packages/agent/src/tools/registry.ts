import type { ToolResult } from "../runtime/types.js";

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    [key: string]: {
      type: string;
      description?: string;
    };
    [key: number]: never;
  };
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Central registry for native TPS agent tools.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool.execute(args);
  }
}
