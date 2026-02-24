/**
 * Ollama generator — produces a Modelfile with system prompt from a TPS report.
 */
import type { TPSReport } from "../schema/report.js";
import { sanitizeTPSReport, sanitizeIdentifier } from "../schema/sanitizer.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GeneratedOllama {
  files: Record<string, string>;
  workspacePath: string;
  agentId: string;
  agentName: string;
  modelTag: string;
}

export function generateOllama(
  rawReport: TPSReport,
  options: { name?: string; workspace?: string; baseModel?: string } = {}
): GeneratedOllama {
  const report = sanitizeTPSReport(rawReport);
  const agentName = options.name ? sanitizeIdentifier(options.name) : report.identity.default_name;
  const agentId = agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-_]/g, "");

  if (!agentId) {
    throw new Error(`Agent name "${agentName}" produces an empty ID after sanitization.`);
  }

  const workspacePath = options.workspace || join(homedir(), "ollama-agents", agentId);
  const baseModel = options.baseModel || "llama3.1:8b";
  const modelTag = `tps-${agentId}`;

  // Build system prompt
  const systemPrompt = [
    `You are ${agentName}, a ${report.name}.`,
    "",
    report.description,
    "",
    `Personality: ${report.identity.personality}`,
    "",
    `Communication style: ${report.identity.communication_style}`,
  ];

  if (report.flair.length > 0) {
    systemPrompt.push("", "Your skills: " + report.flair.join(", ") + ".");
  }

  if (report.boundaries) {
    const rules: string[] = [];
    if (!report.boundaries.can_commit) rules.push("ask before committing code");
    if (!report.boundaries.can_send_external) rules.push("don't send external messages without approval");
    if (!report.boundaries.can_spend) rules.push("no spending without explicit approval");
    if (rules.length > 0) {
      systemPrompt.push("", "Rules: " + rules.join("; ") + ".");
    }
  }

  // Build Modelfile
  const modelfile = [
    `FROM ${baseModel}`,
    "",
    `SYSTEM """`,
    ...systemPrompt,
    `"""`,
    "",
    "# Temperature and parameters",
    "PARAMETER temperature 0.7",
    "PARAMETER top_p 0.9",
    "",
    `# Created by TPS for agent: ${agentName}`,
    `# Base model: ${baseModel}`,
    `# To create: ollama create ${modelTag} -f Modelfile`,
    `# To run: ollama run ${modelTag}`,
    "",
  ].join("\n");

  // Also generate a README for the agent
  const readme = [
    `# ${agentName} (Ollama)`,
    "",
    `**Role:** ${report.name}`,
    `**Base model:** ${baseModel}`,
    `**Model tag:** ${modelTag}`,
    "",
    "## Quick Start",
    "",
    "```bash",
    `cd ${workspacePath}`,
    `ollama create ${modelTag} -f Modelfile`,
    `ollama run ${modelTag}`,
    "```",
    "",
    "## System Prompt",
    "",
    systemPrompt.join("\n"),
    "",
  ].join("\n");

  const files: Record<string, string> = {
    "Modelfile": modelfile,
    "README.md": readme,
  };

  return { files, workspacePath, agentId, agentName, modelTag };
}

export function writeOllama(generated: GeneratedOllama): string[] {
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
