import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { BoundaryManager } from "../governance/boundary.js";
import type { Tool } from "./registry.js";
import type { ToolResult } from "../runtime/types.js";

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
}

/**
 * Normalize whitespace for fuzzy matching:
 * Collapse runs of spaces/tabs (but not newlines) to a single space,
 * and strip leading/trailing whitespace from each line.
 * This handles the common case where the LLM's indentation differs
 * slightly from the file's actual indentation.
 */
function normalizeIndent(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Find `needle` in `haystack`, falling back to indent-normalized matching.
 * Returns the index in the original haystack, or -1 if not found.
 */
function findOccurrence(haystack: string, needle: string): number {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) return exact;

  // Fuzzy: normalize both sides and find in normalized haystack
  const normHaystack = normalizeIndent(haystack);
  const normNeedle = normalizeIndent(needle);
  const normIdx = normHaystack.indexOf(normNeedle);
  if (normIdx === -1) return -1;

  // Map normalized index back to original by counting newlines
  const normLines = normHaystack.slice(0, normIdx).split("\n").length - 1;
  const origLines = haystack.split("\n");
  let origIdx = 0;
  for (let i = 0; i < normLines && i < origLines.length; i++) {
    origIdx += origLines[i]!.length + 1; // +1 for \n
  }
  // Find the actual start of the matching block
  const blockLen = needle.split("\n").length;
  const origBlock = origLines.slice(normLines, normLines + blockLen).join("\n");
  const blockIdx = haystack.indexOf(origBlock, Math.max(0, origIdx - 50));
  return blockIdx !== -1 ? blockIdx : origIdx;
}

export function makeEditTool(boundary: BoundaryManager): Tool {
  return {
    name: "edit",
    description:
      "Search-and-replace in one file. Replaces exactly one occurrence. Prefer narrow, unique context in old_string. Use the write tool to rewrite entire files.",
    input_schema: {
      path: { type: "string", description: "Relative path within workspace" },
      old_string: {
        type: "string",
        description:
          "Exact text to find and replace. Must be unique in the file. Include surrounding lines for context if needed.",
      },
      new_string: {
        type: "string",
        description: "Replacement text",
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const payload = args as unknown as EditArgs;
      if (
        typeof payload.path !== "string" ||
        typeof payload.old_string !== "string" ||
        typeof payload.new_string !== "string"
      ) {
        return {
          content: "edit tool requires path, old_string, new_string",
          isError: true,
        };
      }

      const workspacePath = boundary.resolveWorkspacePath(payload.path);
      if (
        !existsSync(workspacePath) ||
        !BoundaryManager.canFollowSymlink(workspacePath)
      ) {
        if (existsSync(workspacePath)) {
          return {
            content: `Refusing to follow symlink: ${payload.path}`,
            isError: true,
          };
        }
        return {
          content: `edit failed: file not found ${payload.path}`,
          isError: true,
        };
      }

      try {
        const current = readFileSync(workspacePath, "utf-8");

        const first = findOccurrence(current, payload.old_string);
        if (first === -1) {
          return {
            content: `No occurrence of old_string found in ${payload.path}. Tip: use the read tool to verify exact text, or use the write tool to rewrite the full file.`,
            isError: true,
          };
        }

        // Check for multiple occurrences (exact only)
        const last = current.lastIndexOf(payload.old_string);
        if (
          current.indexOf(payload.old_string) !== -1 &&
          current.indexOf(payload.old_string) !== last
        ) {
          return {
            content: `old_string matches multiple locations in ${payload.path} — provide narrower context`,
            isError: true,
          };
        }

        // Replace: use the actual found substring (handles fuzzy match)
        const foundText =
          current.indexOf(payload.old_string) !== -1
            ? payload.old_string
            : current.slice(
                first,
                first + payload.old_string.split("\n").length,
              );

        const next = current.slice(0, first) + payload.new_string + current.slice(first + foundText.length);
        writeFileSync(workspacePath, next, "utf-8");
        return { content: `Edited ${payload.path}`, isError: false };
      } catch (err: any) {
        return {
          content: `edit failed: ${err?.message ?? String(err)}`,
          isError: true,
        };
      }
    },
  };
}
