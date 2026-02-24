/**
 * Claude Code generator — produces CLAUDE.md and .claude/settings.json
 * from a TPS report.
 */
import type { TPSReport } from "../schema/report.js";
import { sanitizeTPSReport, sanitizeIdentifier } from "../schema/sanitizer.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateOperationalBrief } from "./brief.js";

export interface GeneratedClaudeCode {
  files: Record<string, string>;
  workspacePath: string;
  agentId: string;
  agentName: string;
}

export function generateClaudeCode(
  rawReport: TPSReport,
  options: { name?: string; workspace?: string; branch?: boolean } = {}
): GeneratedClaudeCode {
  const report = sanitizeTPSReport(rawReport);
  const agentName = options.name ? sanitizeIdentifier(options.name) : report.identity.default_name;
  const agentId = agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-_]/g, "");

  if (!agentId) {
    throw new Error(`Agent name "${agentName}" produces an empty ID after sanitization.`);
  }

  const workspacePath = options.workspace || join(homedir(), "claude-agents", agentId);

  // Build CLAUDE.md
  const claudeMd = [
    `# ${agentName}`,
    "",
    `**Role:** ${report.name}`,
    "",
    report.description,
    "",
    "## Personality",
    "",
    report.identity.personality,
    "",
    "## Communication Style",
    "",
    report.identity.communication_style,
    "",
    "## Operations",
    "Read OPERATIONS.md to understand your environment and how to use the TPS CLI.",
    "",
  ];

  if (report.flair.length > 0) {
    claudeMd.push("## Skills", "");
    for (const f of report.flair) {
      claudeMd.push(`- ${f}`);
    }
    claudeMd.push("");
  }

  if (report.boundaries) {
    claudeMd.push("## Boundaries", "");
    if (!report.boundaries.can_commit) claudeMd.push("- Ask before committing code");
    if (!report.boundaries.can_send_external) claudeMd.push("- Don't send external messages without approval");
    if (!report.boundaries.can_spend) claudeMd.push("- No spending without explicit approval");
    claudeMd.push("");
  }

  // Build .claude/settings.json
  const settings: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    permissions: {
      allow: report.boundaries?.can_commit
        ? ["Bash(git commit:*)", "Bash(git push:*)"]
        : [],
      deny: [
        "Bash(rm -rf:*)",
        "Bash(curl:*)",
      ],
    },
  };

  const files: Record<string, string> = {
    "CLAUDE.md": claudeMd.join("\n"),
    "OPERATIONS.md": generateOperationalBrief(report, !!options.branch),
    ".claude/settings.json": JSON.stringify(settings, null, 2) + "\n",
  };

  return { files, workspacePath, agentId, agentName };
}

export function writeClaudeCode(generated: GeneratedClaudeCode): string[] {
  const written: string[] = [];
  for (const [name, content] of Object.entries(generated.files)) {
    const filePath = join(generated.workspacePath, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    if (existsSync(filePath)) {
      // Don't overwrite existing files
      continue;
    }
    writeFileSync(filePath, content, "utf-8");
    written.push(name);
  }
  return written;
}
