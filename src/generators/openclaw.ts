import type { TPSReport } from "../schema/report.js";
import { sanitizeTPSReport, sanitizeIdentifier } from "../schema/sanitizer.js";
import Handlebars from "handlebars";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dist, templates are at dist/src/templates; in dev, at src/templates
function findTemplatesDir(): string {
  const candidates = [
    join(__dirname, "..", "templates"),         // dist/src/generators -> dist/src/templates
    join(__dirname, "..", "..", "src", "templates"), // dist/src/generators -> src/templates
    join(__dirname, "..", "..", "..", "src", "templates"), // deeper nesting
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "SOUL.md.hbs"))) return c;
  }
  throw new Error("PC Load Letter? Can't find templates directory.");
}

function loadTemplate(name: string): HandlebarsTemplateDelegate {
  const dir = findTemplatesDir();
  const raw = readFileSync(join(dir, name), "utf-8");
  return Handlebars.compile(raw);
}

import { generateOperationalBrief } from "./brief.js";

// ... previous helper functions ...

Handlebars.registerHelper("json", (ctx: unknown) => JSON.stringify(ctx, null, 2));

export interface GeneratedWorkspace {
  files: Record<string, string>;
  config: Record<string, unknown>;
  workspacePath: string;
}

export function generateWorkspace(
  rawReport: TPSReport,
  options: { name?: string; workspace?: string; branch?: boolean; agentDir?: string; isManager?: boolean } = {}
): GeneratedWorkspace {
  // ops-12.2: Sanitize input report before use
  const report = sanitizeTPSReport(rawReport);

  // If name provided via options, sanitize it too as an identifier
  const agentName = options.name ? sanitizeIdentifier(options.name) : report.identity.default_name;

  // S1.6: Sanitize the agent ID — strip any character that isn't [a-z0-9-_].
  // This prevents path traversal via crafted report names (e.g., "../../.ssh/").
  // The sanitization happens here so it applies whether workspace is explicit or derived.
  const rawId = agentName.toLowerCase().replace(/\s+/g, "-");
  const agentId = rawId.replace(/[^a-z0-9\-_]/g, "");
  if (!agentId) {
    throw new Error(
      `Agent name "${agentName}" produces an empty ID after sanitization. ` +
        `Use only letters, numbers, hyphens, and underscores.`
    );
  }

  const workspacePath =
    options.workspace ||
    (options.branch
      ? join(process.env.HOME || homedir(), ".tps", "branch-office", agentId, "workspace")
      : join(
          process.env.HOME || homedir(),
          ".openclaw",
          `workspace-${agentId}`
        ));

  // Guard: verify the resolved workspace path stays within the selected boundary.
  if (!options.workspace) {
    const boundary = options.branch
      ? resolve((process.env.HOME || homedir()) + "/.tps/branch-office")
      : resolve((process.env.HOME || homedir()) + "/.openclaw");
    const resolved = resolve(workspacePath);
    if (!resolved.startsWith(boundary + "/")) {
      throw new Error(
        `Workspace path escapes ${boundary}: ${workspacePath} → ${resolved}`
      );
    }
  }
  const agentDir = options.agentDir || (options.branch
    ? join(process.env.HOME || "~", ".tps", "branch-office", agentId, "agent")
    : join(
        process.env.HOME || "~",
        ".openclaw",
        "agents",
        agentId,
        "agent"
      ));

  const templateData = {
    ...report,
    agentName,
    agentId,
    workspacePath,
  };

  const templates = [
    options.isManager ? "MANAGER_SOUL.md.hbs" : "SOUL.md.hbs",
    "IDENTITY.md.hbs",
    "AGENTS.md.hbs",
    "USER.md.hbs",
    "TOOLS.md.hbs",
    "HEARTBEAT.md.hbs",
    "package.json.hbs",
    "package-lock.json.hbs",
  ];

  const files: Record<string, string> = {};
  for (const t of templates) {
    const outName = t.replace("MANAGER_", "").replace(".hbs", "");
    const tmpl = loadTemplate(t);
    files[outName] = tmpl(templateData);
  }

  // Inject OPERATIONS.md brief
  files["OPERATIONS.md"] = generateOperationalBrief(report, !!options.branch);

  // Generate config matching actual OpenClaw agent schema
  const config: Record<string, unknown> = {
    id: agentId,
    name: agentName,
    workspace: workspacePath,
    agentDir,
  };

  // Only include thinking if non-default
  if (report.openclaw.thinking && report.openclaw.thinking !== "off") {
    config.thinking = report.openclaw.thinking;
  }

  return { files, config, workspacePath };
}

export function writeWorkspace(generated: GeneratedWorkspace): string[] {
  mkdirSync(generated.workspacePath, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(generated.files)) {
    const filePath = join(generated.workspacePath, name);
    writeFileSync(filePath, content, "utf-8");
    written.push(name);
  }
  return written;
}
