import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { load } from "js-yaml";
import { TpsYamlSchema } from "../schema/manifest.js";

export interface MailHandlerCapability {
  enabled: boolean;
  exec?: string;           // absolute path (resolved from manifest dir)
  priority: number;        // default 100
  timeout: number;         // seconds, default 30
  needs_roster: boolean;   // default false
  match?: {
    from?: string[];       // sender allowlist, "*" = any
    bodyPattern?: string;  // regex against trimmed body
  };
}

export interface RoutingRule {
  pattern: string;  // regex
  to: string;       // agent ID
}

export interface AgentManifest {
  name: string;
  version?: string;
  description?: string;
  capabilities?: { mail_handler?: MailHandlerCapability };
  routing?: RoutingRule[];
  manifestPath: string;  // absolute path to tps.yaml
  agentDir: string;      // directory containing tps.yaml
}

/** Load and parse a tps.yaml file. Returns null if missing or invalid. */
export function loadManifest(tpsYamlPath: string): AgentManifest | null {
  try {
    if (!existsSync(tpsYamlPath)) return null;
    const content = readFileSync(tpsYamlPath, "utf-8");
    const doc = load(content);

    const parsed = TpsYamlSchema.safeParse(doc);
    if (!parsed.success) return null;

    const data = parsed.data;
    const agentDir = dirname(resolve(tpsYamlPath));
    const manifestPath = resolve(tpsYamlPath);

    const manifest: AgentManifest = {
      name: data.name,
      version: data.version,
      description: data.description,
      routing: data.routing,
      manifestPath,
      agentDir,
    };

    if (data.capabilities?.mail_handler) {
      const mh = data.capabilities.mail_handler;
      const mail_handler: MailHandlerCapability = {
        enabled: mh.enabled,
        priority: mh.priority,
        timeout: mh.timeout,
        needs_roster: mh.needs_roster,
        match: mh.match,
      };

      if (mh.exec) {
        const resolvedExec = resolve(agentDir, mh.exec);
        if (!resolvedExec.startsWith(agentDir)) {
          return null; // Boundary check from S15
        }
        mail_handler.exec = resolvedExec;
      }

      manifest.capabilities = { mail_handler };
    }

    return manifest;
  } catch (err) {
    return null;
  }
}

/** Scan agentsDir for tps.yaml files. Returns sorted by priority ascending (lowest first). */
export function discoverManifests(agentsDir: string): AgentManifest[] {
  try {
    if (!existsSync(agentsDir)) return [];
    const entries = readdirSync(agentsDir);
    const manifests: AgentManifest[] = [];

    for (const entry of entries) {
      const fullPath = join(agentsDir, entry);
      if (statSync(fullPath).isDirectory()) {
        const yamlPath = join(fullPath, "tps.yaml");
        const m = loadManifest(yamlPath);
        if (m) manifests.push(m);
      }
    }

    return manifests.sort((a, b) => {
      const pA = a.capabilities?.mail_handler?.priority ?? 100;
      const pB = b.capabilities?.mail_handler?.priority ?? 100;
      return pA - pB;
    });
  } catch (err) {
    return [];
  }
}

/** Check if a message matches a manifest's match filter. */
export function matchesFilter(
  manifest: AgentManifest,
  msg: { from: string; body: string }
): boolean {
  const filter = manifest.capabilities?.mail_handler?.match;
  if (!filter) return true;

  if (filter.from && filter.from.length > 0 && !filter.from.includes("*")) {
    if (!filter.from.includes(msg.from)) return false;
  }

  if (filter.bodyPattern) {
    const re = new RegExp(filter.bodyPattern);
    const bodyToTest = msg.body.trim().slice(0, 1024); // Capped at 1024 (S15)
    if (!re.test(bodyToTest)) return false;
  }

  return true;
}
