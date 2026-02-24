/**
 * Codex CLI generator — produces instructions.md and codex config
 * from a TPS report.
 * 
 * Codex CLI (OpenAI) uses:
 * - instructions.md or AGENTS.md for system instructions
 * - .codex/config.json for settings
 */
import type { TPSReport } from "../schema/report.js";
import { sanitizeTPSReport, sanitizeIdentifier } from "../schema/sanitizer.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateOperationalBrief } from "./brief.js";

export interface GeneratedCodex {
  files: Record<string, string>;
  workspacePath: string;
  agentId: string;
  agentName: string;
}

export function generateCodex(
  rawReport: TPSReport,
  options: { name?: string; workspace?: string; model?: string; branch?: boolean } = {}
): GeneratedCodex {
  const report = sanitizeTPSReport(rawReport);
  const agentName = options.name ? sanitizeIdentifier(options.name) : report.identity.default_name;
  const agentId = agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-_]/g, "");

  if (!agentId) {
    throw new Error(`Agent name "${agentName}" produces an empty ID after sanitization.`);
  }

  const workspacePath = options.workspace || join(homedir(), "codex-agents", agentId);
  const model = options.model || "o3";

  // Build AGENTS.md (Codex's instruction file)
  const instructions = [
    `# ${agentName}`,
    "",
    `**Role:** ${report.name}`,
    "",
    report.description,
    "",
    "## Operations",
    "Read OPERATIONS.md to understand your environment and how to use the TPS CLI.",
    "",
    "## Personality",
    "",
    report.identity.personality,
    "",
    "## Communication Style",
    "",
    report.identity.communication_style,
    "",
  ];

  if (report.flair.length > 0) {
    instructions.push("## Skills", "");
    for (const f of report.flair) {
      instructions.push(`- ${f}`);
    }
    instructions.push("");
  }

  if (report.boundaries) {
    instructions.push("## Boundaries", "");
    if (report.boundaries.can_commit) {
      instructions.push("- You may commit and push code directly");
    } else {
      instructions.push("- Ask before committing code");
    }
    if (!report.boundaries.can_send_external) {
      instructions.push("- Don't send external messages without approval");
    }
    if (!report.boundaries.can_spend) {
      instructions.push("- No spending without explicit approval");
    }
    instructions.push("");
  }

  // Build codex config
  const config: Record<string, unknown> = {
    model,
    approval_mode: report.boundaries?.can_commit ? "auto-edit" : "suggest",
    instructions_file: "AGENTS.md",
  };

  const files: Record<string, string> = {
    "AGENTS.md": instructions.join("\n"),
    "OPERATIONS.md": generateOperationalBrief(report, !!options.branch),
    ".codex/config.json": JSON.stringify(config, null, 2) + "\n",
  };

  return { files, workspacePath, agentId, agentName };
}

export function writeCodex(generated: GeneratedCodex): string[] {
  const written: string[] = [];
  for (const [name, content] of Object.entries(generated.files)) {
    const filePath = join(generated.workspacePath, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    if (existsSync(filePath)) continue;
    writeFileSync(filePath, content, "utf-8");
    written.push(name);
  }
  return written;
}
