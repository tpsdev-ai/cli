/**
 * tps skill — Skill governance lifecycle commands (ops-31.4)
 *
 * Manages skill assignments as Soul records in Flair.
 * Skills are knowledge packages — not executable code.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createFlairClient, defaultFlairKeyPath } from "../utils/flair-client.js";

export interface SkillArgs {
  action: "list" | "register" | "scan" | "revoke" | "show" | "addPack";
  agent?: string;
  name?: string;
  version?: string;
  source?: string;
  file?: string;
  priority?: string;
  json?: boolean;
  flairUrl?: string;
  includeRules?: string;
  ruleNameFormat?: string;
  registry?: string;
}

// ─── Pack loader types & exports ────────────────────────────────────────────

export interface PackContents {
  ruleNames: readonly string[];
  rules: Record<string, string>;
  skillSummary: string;
  version: string;
  author?: string;
  maintainer?: string;
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
    case "addPack":
      return addPack(args);
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

// ─── addPack — bulk-import npm-shipped skill packs ───────────────────────────

async function addPack(args: SkillArgs): Promise<void> {
  const pkgName = args.source;
  const { agent, priority, includeRules, ruleNameFormat, registry, flairUrl } = args;

  if (!pkgName || !agent) {
    console.error(
      "Usage: tps skill add-pack <npm-package> --agent <id> [--priority standard]" +
        " [--include-rules <rule1,rule2,...>] [--rule-name-format <pack>:<rule>] [--registry <url>]",
    );
    process.exit(1);
  }

  // 1. Resolve & extract the pack
  let pack: PackContents;
  try {
    pack = await resolveAndExtractPack(pkgName, registry);
  } catch (err: any) {
    console.error(`Failed to resolve pack ${pkgName}: ${err.message}`);
    process.exit(1);
  }

  // 2. Validate skillSummary 8KB cap
  const summaryBytes = new TextEncoder().encode(pack.skillSummary).length;
  if (summaryBytes > 8192) {
    console.error(`pack summary exceeds 8KB cap (${summaryBytes} bytes)`);
    process.exit(1);
  }

  // 3. Security scan the summary
  const validPriorities = ["critical", "high", "standard", "low"];
  const skillPriority = (priority && validPriorities.includes(priority) ? priority : "standard") as
    "critical" | "high" | "standard" | "low";

  const flair = createFlairClient(agent, flairUrl, defaultFlairKeyPath(agent));

  console.log("Scanning skill summary...");
  const scan = await flair.scanSkill(pack.skillSummary);

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

  // 4. Canonical name & source tag
  const canonicalName = extractPackCanonicalName(pkgName);
  const sourceTag = `npm:${pkgName}@${pack.version}`;

  // 5. Idempotency check
  const existing = await flair.listSkills(agent);
  const existingMatch = existing.find((s) => s.value === canonicalName);
  if (existingMatch) {
    let meta: any = {};
    try { meta = JSON.parse(existingMatch.metadata ?? "{}"); } catch {}
    if (meta.version === pack.version) {
      console.log(`Skill '${canonicalName}' v${pack.version} already registered — skipping.`);
    } else {
      console.error(
        `Skill '${canonicalName}' exists with different version (${meta.version} vs ${pack.version}). ` +
          `Use \`tps skill revoke ${canonicalName} --agent ${agent}\` first.`,
      );
      process.exit(1);
    }
    return;
  }

  // 6. Register the summary skill
  await flair.registerSkill(agent, {
    name: canonicalName,
    priority: skillPriority,
    source: sourceTag,
    version: pack.version,
    content: pack.skillSummary,
  });

  let registeredCount = 1;
  console.log(`Registered: ${canonicalName} v${pack.version} [source: ${sourceTag}] (${summaryBytes} bytes)`);

  // 7. Handle --include-rules
  if (includeRules) {
    const requested = includeRules
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const unknown = requested.filter((r) => !pack.ruleNames.includes(r));
    if (unknown.length > 0) {
      console.error(
        `Unknown rule(s): ${unknown.join(", ")}. Available: ${pack.ruleNames.join(", ")}`,
      );
      process.exit(1);
    }

    const fmt = ruleNameFormat ?? "<pack>:<rule>";

    for (const ruleName of requested) {
      const ruleContent = pack.rules[ruleName];
      if (!ruleContent) {
        console.error(`Rule '${ruleName}' has no content, skipping.`);
        continue;
      }

      // 8KB check on rule content
      const ruleBytes = new TextEncoder().encode(ruleContent).length;
      if (ruleBytes > 8192) {
        console.error(`Rule '${ruleName}' exceeds 8KB cap (${ruleBytes} bytes), skipping.`);
        continue;
      }

      // Scan rule content
      const ruleScan = await flair.scanSkill(ruleContent);
      if (ruleScan.riskLevel === "high" || ruleScan.riskLevel === "critical") {
        console.error(
          `Rule '${ruleName}' blocked: risk level ${ruleScan.riskLevel}, skipping.`,
        );
        continue;
      }

      const formattedName = fmt.replace("<pack>", canonicalName).replace("<rule>", ruleName);

      // Idempotency for rules too
      const ruleMatch = existing.find((s) => s.value === formattedName);
      if (ruleMatch) {
        let rmeta: any = {};
        try { rmeta = JSON.parse(ruleMatch.metadata ?? "{}"); } catch {}
        if (rmeta.version === pack.version) {
          console.log(`  Rule '${formattedName}' already registered — skipping.`);
          continue;
        }
        console.error(
          `  Rule '${formattedName}' exists with different version (${rmeta.version} vs ${pack.version}), skipping.`,
        );
        continue;
      }

      await flair.registerSkill(agent, {
        name: formattedName,
        priority: skillPriority,
        source: sourceTag,
        version: pack.version,
        content: ruleContent,
      });

      registeredCount++;
      console.log(`  Rule: ${formattedName} (${ruleBytes} bytes)`);
    }
  }

  // 8. Summary
  console.log(`\nDone. ${registeredCount} skill(s) registered from ${sourceTag}.`);
}

// ─── Pack loader utilities (exported for testing) ────────────────────────────

/**
 * Load a pack from an already-extracted package directory.
 * The dir should contain package.json and dist/index.js (or dist/index.mjs).
 */
export async function loadPackFromDir(packageDir: string): Promise<PackContents> {
  // Read package.json
  const pkgJsonPath = join(packageDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${packageDir}`);
  }

  let pkgJson: any;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    throw new Error(`Failed to parse package.json in ${packageDir}`);
  }

  const version: string = pkgJson.version ?? "0.0.0";

  // Parse author
  let author: string | undefined;
  if (typeof pkgJson.author === "string") {
    author = pkgJson.author;
  } else if (pkgJson.author?.name) {
    author = pkgJson.author.name;
  }

  // Parse maintainer
  let maintainer: string | undefined;
  const maintainers =
    pkgJson.maintainers ?? (pkgJson.maintainer ? [pkgJson.maintainer] : []);
  if (maintainers.length > 0) {
    const first = maintainers[0];
    if (typeof first === "string") {
      maintainer = first;
    } else if (first?.name) {
      maintainer = first.name;
    }
  }

  // Dynamic-import dist/index.js (try .js then .mjs)
  let indexPath = join(packageDir, "dist", "index.js");
  if (!existsSync(indexPath)) {
    indexPath = join(packageDir, "dist", "index.mjs");
    if (!existsSync(indexPath)) {
      throw new Error(`dist/index.js not found in ${packageDir}`);
    }
  }

  let mod: any;
  try {
    mod = await import(pathToFileURL(indexPath).href);
  } catch (err: any) {
    throw new Error(
      `Failed to import dist/index.js from ${packageDir}: ${err.message}`,
    );
  }

  if (!mod.ruleNames || !mod.rules || !mod.skillSummary) {
    throw new Error(
      "Pack must export ruleNames, rules, and skillSummary from dist/index.js",
    );
  }

  return {
    ruleNames: mod.ruleNames as readonly string[],
    rules: mod.rules as Record<string, string>,
    skillSummary: mod.skillSummary as string,
    version,
    author,
    maintainer,
  };
}

/**
 * Resolve a pack from npm, download the tarball, extract, and load.
 */
export async function resolveAndExtractPack(
  pkgName: string,
  registry?: string,
): Promise<PackContents> {
  const { execSync } = await import("node:child_process");

  const packDir = mkdtempSync(join(tmpdir(), "tps-pack-"));
  let extractDir: string | undefined;

  try {
    // npm pack → download tarball
    const npmArgs = ["pack", pkgName, "--pack-destination", packDir];
    if (registry) {
      npmArgs.push("--registry", registry);
    }

    let result: string;
    try {
      result = execSync(`npm ${npmArgs.join(" ")}`, {
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? "";
      throw new Error(`npm pack ${pkgName} failed: ${stderr || err.message}`);
    }

    const lines = result.trim().split("\n");
    const tgzName = lines[lines.length - 1]?.trim();
    if (!tgzName || !tgzName.endsWith(".tgz")) {
      throw new Error(
        `npm pack ${pkgName} did not produce a .tgz file. Output: ${result}`,
      );
    }

    const tgzPath = join(packDir, tgzName);
    if (!existsSync(tgzPath)) {
      throw new Error(`npm pack output file not found: ${tgzPath}`);
    }

    // Extract the tarball
    extractDir = mkdtempSync(join(tmpdir(), "tps-extract-"));
    try {
      execSync(`tar -xzf "${tgzPath}" -C "${extractDir}"`, { timeout: 10_000 });
    } catch (err: any) {
      throw new Error(`Failed to extract tarball ${tgzName}: ${err.message}`);
    }

    // Tarballs unpack into a "package/" directory
    const packageDir = join(extractDir, "package");
    if (!existsSync(packageDir)) {
      throw new Error(
        `Extracted package has unexpected structure (expected 'package/' dir in ${extractDir})`,
      );
    }

    return await loadPackFromDir(packageDir);
  } finally {
    // Cleanup temp dirs
    rmSync(packDir, { recursive: true, force: true });
    if (extractDir) {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

/**
 * Derive a canonical skill name from an npm package specifier.
 * @harperfast/skills@1.4.2 → harperfast-skills
 */
export function extractPackCanonicalName(pkgName: string): string {
  // Strip leading @ and version suffix (@scope/name@version)
  const cleaned = pkgName.replace(/^@/, "").replace(/@[\d.]+$/, "");
  return cleaned.replace("/", "-");
}
