/**
 * tps skill — Skill governance lifecycle commands (ops-31.4)
 *
 * Manages skill assignments as Soul records in Flair.
 * Skills are knowledge packages — not executable code.
 */
import { readFileSync } from "node:fs";
import { createFlairClient, defaultFlairKeyPath } from "../utils/flair-client.js";

export interface SkillArgs {
  action: "list" | "register" | "scan" | "revoke" | "show";
  agent?: string;
  name?: string;
  version?: string;
  source?: string;
  file?: string;
  priority?: string;
  json?: boolean;
  flairUrl?: string;
}

export async function runSkill(args: SkillArgs): Promise<void> {
  switch (args.action) {
    case "list":
      return listSkills(args);
    case "register":
      return registerSkill(args);
    case "scan":
      return scanSkill(args);
    case "revoke":
      return revokeSkill(args);
    case "show":
      return showSkill(args);
  }
}

async function listSkills(args: SkillArgs): Promise<void> {
  const agentId = args.agent;
  if (!agentId) {
    console.error("Usage: tps skill list --agent <id>");
    process.exit(1);
  }

  const flair = createFlairClient(agentId, args.flairUrl, defaultFlairKeyPath(agentId));
  const skills = await flair.listSkills(agentId);

  if (args.json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (skills.length === 0) {
    console.log(`No skills assigned to ${agentId}.`);
    return;
  }

  console.log(`Skills assigned to ${agentId}:\n`);
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, standard: 2, low: 3 };
  skills.sort((a, b) => (priorityOrder[a.priority ?? "standard"] ?? 2) - (priorityOrder[b.priority ?? "standard"] ?? 2));

  for (const s of skills) {
    let meta: any = {};
    try { meta = JSON.parse(s.metadata ?? "{}"); } catch {}
    const src = meta.source ? ` (source: ${meta.source})` : "";
    console.log(`  ${s.value}  [${s.priority ?? "standard"}]${src}`);
  }
}

async function registerSkill(args: SkillArgs): Promise<void> {
  const { agent, name, version, source, priority, file } = args;
  if (!agent || !name || !version || !source) {
    console.error("Usage: tps skill register <source> --name <n> --version <hash> --agent <id> [--priority standard]");
    process.exit(1);
  }

  // Read skill content from source file if provided
  let content = "";
  const filePath = file ?? source;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.error(`Cannot read skill source: ${filePath}`);
    process.exit(1);
  }

  // Client-side 8KB check
  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > 8192) {
    console.error(`Skill exceeds 8KB limit (${byteLength} bytes). Skills are patterns, not documentation.`);
    process.exit(1);
  }

  const flair = createFlairClient(agent, args.flairUrl, defaultFlairKeyPath(agent));

  // Auto-scan before registration
  console.log("Scanning skill content...");
  const scan = await flair.scanSkill(content);

  if (!scan.safe) {
    console.log(`\nScan found ${scan.violations.length} violation(s) — risk: ${scan.riskLevel}\n`);
    for (const v of scan.violations) {
      console.log(`  L${v.line}: [${v.type}] ${v.content}`);
    }
  }

  if (scan.riskLevel === "high" || scan.riskLevel === "critical") {
    console.error(`\nRegistration blocked: risk level is ${scan.riskLevel}. Skill must pass review.`);
    process.exit(1);
  }

  if (scan.safe) {
    console.log("Scan passed: no violations detected.");
  }

  const validPriorities = ["critical", "high", "standard", "low"];
  const skillPriority = (priority && validPriorities.includes(priority) ? priority : "standard") as
    "critical" | "high" | "standard" | "low";

  await flair.registerSkill(agent, {
    name,
    priority: skillPriority,
    source,
    version,
    content,
  });

  console.log(`\nSkill '${name}' registered and assigned to ${agent} [${skillPriority}].`);
}

async function scanSkill(args: SkillArgs): Promise<void> {
  const filePath = args.file;
  if (!filePath) {
    console.error("Usage: tps skill scan <file>");
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > 8192) {
    console.error(`File exceeds 8KB limit (${byteLength} bytes).`);
    process.exit(1);
  }

  // Use a default agent ID for scan-only (read-only operation)
  const agentId = args.agent ?? process.env.TPS_AGENT_ID ?? "nathan";
  const flair = createFlairClient(agentId, args.flairUrl, defaultFlairKeyPath(agentId));
  const result = await flair.scanSkill(content);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.safe) {
    console.log(`Scan passed: no violations. Risk: ${result.riskLevel}`);
  } else {
    console.log(`Scan complete: ${result.violations.length} violation(s) — risk: ${result.riskLevel}\n`);
    for (const v of result.violations) {
      console.log(`  L${v.line}: [${v.type}] ${v.content}`);
    }
  }

  console.log("\nNote: discovery and evaluation should happen in a sandboxed session with no access to agent state.");
}

async function revokeSkill(args: SkillArgs): Promise<void> {
  const { agent, name } = args;
  if (!agent || !name) {
    console.error("Usage: tps skill revoke <name> --agent <id>");
    process.exit(1);
  }

  const flair = createFlairClient(agent, args.flairUrl, defaultFlairKeyPath(agent));
  await flair.revokeSkill(agent, name);
  console.log(`Skill '${name}' revoked from ${agent}. Takes effect on next bootstrap.`);
}

async function showSkill(args: SkillArgs): Promise<void> {
  const { agent, name } = args;
  if (!agent || !name) {
    console.error("Usage: tps skill show <name> --agent <id>");
    process.exit(1);
  }

  const flair = createFlairClient(agent, args.flairUrl, defaultFlairKeyPath(agent));
  const skills = await flair.listSkills(agent);
  const skill = skills.find((s) => s.value === name);

  if (!skill) {
    console.error(`Skill '${name}' not found for agent ${agent}.`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  let meta: any = {};
  try { meta = JSON.parse(skill.metadata ?? "{}"); } catch {}

  console.log(`Skill: ${skill.value}`);
  console.log(`Priority: ${skill.priority ?? "standard"}`);
  console.log(`Agent: ${skill.agentId}`);
  if (meta.source) console.log(`Source: ${meta.source}`);
  if (meta.version) console.log(`Version: ${meta.version}`);
  if (meta.hash) console.log(`Hash: ${meta.hash}`);
  if (meta.reviewedBy) console.log(`Reviewed by: ${meta.reviewedBy}`);
  if (meta.reviewedAt) console.log(`Reviewed at: ${meta.reviewedAt}`);
  if (meta.status) console.log(`Status: ${meta.status}`);
  console.log(`Created: ${skill.createdAt}`);
}
