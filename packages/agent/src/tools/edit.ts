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
 * Returns { index, matchedText } where matchedText is the actual substring
 * in haystack that corresponds to needle (needed for correct replacement).
 * Returns null if not found.
 */
function findOccurrence(
  haystack: string,
  needle: string,
): { index: number; matchedText: string } | null {
  // Exact match — fast path
  const exact = haystack.indexOf(needle);
  if (exact !== -1) return { index: exact, matchedText: needle };

  // Fuzzy: normalize indentation on both sides
  const normHaystack = normalizeIndent(haystack);
  const normNeedle = normalizeIndent(needle);
  const normIdx = normHaystack.indexOf(normNeedle);
  if (normIdx === -1) return null;

  // Map the normalized index back to an original-string line number
  const normLines = normHaystack.slice(0, normIdx).split("\n").length - 1;
  const needleLineCount = needle.split("\n").length;
  const origLines = haystack.split("\n");

  // Reconstruct the actual text block from the original lines
  const origBlock = origLines
    .slice(normLines, normLines + needleLineCount)
    .join("\n");

  // Find (and verify) the block in the original haystack
  let charOffset = 0;
  for (let i = 0; i < normLines && i < origLines.length; i++) {
    charOffset += origLines[i]!.length + 1; // +1 for \n
  }
  const blockIdx = haystack.indexOf(origBlock, Math.max(0, charOffset - 50));
  if (blockIdx === -1) return null;

  return { index: blockIdx, matchedText: origBlock };
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

        const match = findOccurrence(current, payload.old_string);
        if (match === null) {
          return {
            content: `No occurrence of old_string found in ${payload.path}. Tip: use the read tool to verify exact text, or use the write tool to rewrite the full file.`,
            isError: true,
          };
        }
        const { index: first, matchedText } = match;

        // Check for multiple occurrences (exact only, to keep fuzzy safe)
        const exactOccurrences = current.split(payload.old_string).length - 1;
        const normOccurrences = normalizeIndent(current).split(normalizeIndent(payload.old_string)).length - 1;
        if (exactOccurrences > 1 || normOccurrences > 1) {
          return {
            content: `old_string matches multiple locations in ${payload.path} — provide narrower context`,
            isError: true,
          };
        }

        const next =
          current.slice(0, first) +
          payload.new_string +
          current.slice(first + matchedText.length);
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
