import { readFileSync, existsSync } from "node:fs";
import { BoundaryManager } from "../governance/boundary.js";
import type { Tool } from "./registry.js";
import type { ToolResult } from "../runtime/types.js";

interface ReadArgs {
  path: string;
}

export function makeReadTool(boundary: BoundaryManager): Tool {
  return {
    name: "read",
    description: "Read file contents from workspace.\nInput: {\"path\": string}",
    input_schema: {
      path: {
        type: "string",
        description: "Path to read, relative to workspace",
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const { path: rawPath } = (args as unknown) as ReadArgs;
      if (typeof rawPath !== "string") {
        return { content: "read tool requires path string", isError: true };
      }

      const workspacePath = boundary.resolveWorkspacePath(rawPath);
      if (existsSync(workspacePath) && !BoundaryManager.canFollowSymlink(workspacePath)) {
        return { content: `Refusing to follow symlink: ${rawPath}`, isError: true };
      }

      try {
        return { content: readFileSync(workspacePath, "utf-8"), isError: false };
      } catch (err: any) {
        return { content: `read failed: ${err?.message ?? String(err)}`, isError: true };
      }
    },
  };
}
