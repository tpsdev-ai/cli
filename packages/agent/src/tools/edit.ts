import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { BoundaryManager } from "../governance/boundary.js";
import type { Tool } from "./registry.js";
import type { ToolResult } from "../runtime/types.js";

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
}

export function makeEditTool(boundary: BoundaryManager): Tool {
  return {
    name: "edit",
    description: "Search-and-replace in one file. Replaces exactly one occurrence.\nInput: {\"path\": string, \"old_string\": string, \"new_string\": string}",
    input_schema: {
      path: { type: "string", description: "Path in workspace" },
      old_string: { type: "string", description: "Text to replace" },
      new_string: { type: "string", description: "Replacement text" },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const payload = (args as unknown) as EditArgs;
      if (
        typeof payload.path !== "string" ||
        typeof payload.old_string !== "string" ||
        typeof payload.new_string !== "string"
      ) {
        return { content: "edit tool requires path, old_string, new_string", isError: true };
      }

      const workspacePath = boundary.resolveWorkspacePath(payload.path);
      if (!existsSync(workspacePath) || !BoundaryManager.canFollowSymlink(workspacePath)) {
        if (existsSync(workspacePath)) {
          return { content: `Refusing to follow symlink: ${payload.path}`, isError: true };
        }
        return { content: `edit failed: file not found ${payload.path}`, isError: true };
      }

      try {
        const current = readFileSync(workspacePath, "utf-8");
        const first = current.indexOf(payload.old_string);
        const last = current.lastIndexOf(payload.old_string);

        if (first === -1) {
          return { content: `No occurrence of old_string found in ${payload.path}`, isError: true };
        }
        if (first !== last) {
          return { content: `old_string matches multiple locations in ${payload.path} — provide narrower context`, isError: true };
        }

        const next = current.replace(payload.old_string, payload.new_string);
        writeFileSync(workspacePath, next, "utf-8");
        return { content: `Edited ${payload.path}`, isError: false };
      } catch (err: any) {
        return { content: `edit failed: ${err?.message ?? String(err)}`, isError: true };
      }
    },
  };
}
