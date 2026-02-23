import { dirname, join, resolve } from "node:path";
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { OfficeManifest, parseOfficeManifest } from "../schema/manifest.js";
import { resolveReportPath } from "./output.js";
import { parseTPSReport } from "../schema/report.js";
import { generateWorkspace } from "../generators/openclaw.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { getInternalInbox } from "./internal-mail.js";
import { initWall } from "./wall.js";

function isWithin(base: string, candidate: string): boolean {
  const b = resolve(base);
  const c = resolve(candidate);
  return c === b || c.startsWith(`${b}/`);
}

function validateAndResolveHostMount(hostPath: string): string {
  const expanded = hostPath.startsWith("~/")
    ? join(process.env.HOME || "", hostPath.slice(2))
    : hostPath;
  const absolute = resolve(expanded);
  const home = resolve(process.env.HOME || "");
  const homeReal = realpathSync(home);

  if (!isWithin(home, absolute) && !isWithin(homeReal, absolute)) {
    throw new Error(`Mount host path must stay within HOME: ${hostPath}`);
  }

  const lst = lstatSync(absolute);
  if (lst.isSymbolicLink()) {
    throw new Error(`Mount host path cannot be a symlink: ${hostPath}`);
  }

  const real = realpathSync(absolute);
  if (!isWithin(homeReal, real)) {
    throw new Error(`Mount host path resolves outside HOME: ${hostPath}`);
  }

  const st = statSync(real);
  if (!st.isFile()) {
    throw new Error(`Mount host path must be a regular file: ${hostPath}`);
  }

  return real;
}

function validateAndResolveTargetMount(sharedWorkspace: string, targetPath: string): string {
  if (targetPath.startsWith("/") || targetPath.includes("..")) {
    throw new Error(`Mount target must be a relative workspace path: ${targetPath}`);
  }

  const wsReal = realpathSync(sharedWorkspace);
  const absolute = resolve(wsReal, targetPath);
  if (!isWithin(wsReal, absolute)) {
    throw new Error(`Mount target escapes workspace: ${targetPath}`);
  }

  return absolute;
}

export function provisionTeam(manifestPath: string, branchRoot: string): string {
  const manifest = parseOfficeManifest(manifestPath);

  if (manifest.purpose === "adversarial") {
    throw new Error("Adversarial offices require per-agent isolation (not yet implemented). Use 'development', 'research', or 'ops' purpose instead.");
  }

  const teamId = sanitizeIdentifier(manifest.name);
  const teamDir = join(branchRoot, teamId);
  const dotOpenClaw = join(teamDir, ".openclaw");
  const agentsRoot = join(dotOpenClaw, "agents");
  const sharedWorkspace = join(teamDir, "workspace");

  mkdirSync(dotOpenClaw, { recursive: true });
  mkdirSync(agentsRoot, { recursive: true });
  mkdirSync(sharedWorkspace, { recursive: true });

  const agentConfigs: any[] = [];
  const agents = [manifest.manager, ...manifest.agents];
  const agentIds = new Set<string>();

  for (const agentSpec of agents) {
    const reportPath = resolveReportPath(agentSpec.persona);
    const report = parseTPSReport(reportPath);

    if (agentSpec.role) {
        report.name = agentSpec.role;
    }

    // Determine agent ID ahead of time to build paths
    const tempGen = generateWorkspace(report, { name: agentSpec.name });
    const agentId = String(tempGen.config.id);

    if (agentIds.has(agentId)) {
        throw new Error(`Duplicate agent ID in manifest: ${agentId}`);
    }
    agentIds.add(agentId);

    const agentRoot = join(agentsRoot, agentId);
    const agentDir = join(agentRoot, "agent");

    const isManager = agentSpec === manifest.manager;
    // Generate with correct paths
    const generated = generateWorkspace(report, {
        name: agentSpec.name,
        workspace: sharedWorkspace,
        branch: true,
        agentDir: agentDir,
        isManager: isManager,
    });

    // Write agent definition files to agentDir
    mkdirSync(agentDir, { recursive: true });
    for (const [name, content] of Object.entries(generated.files)) {
        // Skip package files for agent dirs
        if (name === "package.json" || name === "package-lock.json") {
            continue; 
        }
        writeFileSync(join(agentDir, name), content, "utf-8");
    }

    // Write tps.yaml for the agent
    const tpsYamlContent = `name: ${agentId}
version: "1.0.0"
description: ${report.description?.trim().split('\n')[0] || "Generated agent"}
`;
    writeFileSync(join(agentRoot, "tps.yaml"), tpsYamlContent, "utf-8");

    agentConfigs.push(generated.config);
  }

  // Write shared openclaw.json
  const sandboxConfig = {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: ["ollama/qwen2.5:7b"],
        },
        heartbeat: {
          every: "30m",
        },
      },
      list: agentConfigs,
    },
  };
  writeFileSync(join(dotOpenClaw, "openclaw.json"), JSON.stringify(sandboxConfig, null, 2), "utf-8");

  // Write shared package.json and lockfile
  // We can use the templates from the last agent generation, but with team ID
  // Or just construct a minimal one.
  const packageJson = {
      name: `workspace-${teamId}`,
      version: "0.0.0",
      private: true,
      description: "Generated by TPS. Do not modify manually.",
      scripts: {},
      dependencies: {},
      devDependencies: {}
  };
  
  writeFileSync(join(sharedWorkspace, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
  
  // Minimal lockfile v3
  const lockfile = {
      name: `workspace-${teamId}`,
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: `workspace-${teamId}`,
          version: "0.0.0",
          license: "UNLICENSED",
          dependencies: {},
          devDependencies: {}
        }
      }
  };
  writeFileSync(join(sharedWorkspace, "package-lock.json"), JSON.stringify(lockfile, null, 2), "utf-8");

  // Setup internal mail inboxes for all agents
  for (const agentId of agentIds) {
    getInternalInbox(sharedWorkspace, agentId);
  }

  // Initialize broadcast wall if enabled
  if (manifest.wall) {
    initWall(sharedWorkspace, manifest.name);
  }

  // Optional context injection (briefs + mounts)
  if (manifest.context?.briefs && manifest.context.briefs.length > 0) {
    const content = [
      "# CONTEXT",
      "",
      ...manifest.context.briefs.map((b: string, i: number) => `- ${i + 1}. ${b}`),
      "",
    ].join("\n");
    writeFileSync(join(sharedWorkspace, "CONTEXT.md"), content, "utf-8");
  }

  if (manifest.context?.mounts && manifest.context.mounts.length > 0) {
    for (const mount of manifest.context.mounts) {
      if (mount.readonly !== true) {
        throw new Error(`Mount readonly must be true: ${mount.target}`);
      }
      const source = validateAndResolveHostMount(mount.host);
      const target = validateAndResolveTargetMount(sharedWorkspace, mount.target);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  // Write team membership sidecar for relay lookups
  // Relay reads this instead of re-parsing office.yaml on every delivery
  const teamMembership = {
    teamId,
    members: Array.from(agentIds),
    workspaceMail: join(sharedWorkspace, "mail"),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(teamDir, "team.json"), JSON.stringify(teamMembership, null, 2), "utf-8");

  return teamDir;
}
