import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { BoundaryManager } from "../governance/boundary.js";
import type { Tool } from "./registry.js";
import type { ToolResult } from "../runtime/types.js";

interface WriteArgs {
  path: string;
  content: string;
}

export function makeWriteTool(boundary: BoundaryManager): Tool {
  return {
    name: "write",
    description: "Create or overwrite a file.\nInput: {\"path\": string, \"content\": string}",
    input_schema: {
      path: { type: "string", description: "Path to write, relative to workspace" },
      content: { type: "string", description: "File contents" },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const payload = (args as unknown) as WriteArgs;
      if (typeof payload.path !== "string" || typeof payload.content !== "string") {
        return { content: "write tool requires path and content strings", isError: true };
      }

      const workspacePath = boundary.resolveWorkspacePath(payload.path);
      if (existsSync(workspacePath) && !BoundaryManager.canFollowSymlink(workspacePath)) {
        return { content: `Refusing to follow symlink: ${payload.path}`, isError: true };
      }

      try {
        mkdirSync(dirname(workspacePath), { recursive: true });
        writeFileSync(workspacePath, payload.content, "utf-8");
        return { content: `Wrote ${payload.path}`, isError: false };
      } catch (err: any) {
        return { content: `write failed: ${err?.message ?? String(err)}`, isError: true };
      }
    },
  };
}
