import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import yaml from "js-yaml";

/** Tool entry that can be a bare string or a versioned object. */
const ToolEntrySchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), version: z.string().optional() }),
]);

/** curl-installed binary spec */
const CurlBinarySchema = z.object({
  url: z.string().url(),
  dest: z.string().min(1),
  chmod: z.string().default("755"),
});

/**
 * Workspace Manifest — defines tools the Office Manager installs before
 * worker agents start. Place this file at `workspace/workspace-manifest.json`
 * (or `workspace-manifest.yaml`).
 *
 * Example:
 * ```json
 * {
 *   "name": "dev-office",
 *   "tools": {
 *     "apk": ["git", "curl", "jq"],
 *     "npm": ["gh"],
 *     "curl": [{ "url": "https://…", "dest": "/usr/local/bin/foo" }]
 *   }
 * }
 * ```
 */
export const WorkspaceManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tools: z.object({
    /** Alpine (apk) packages */
    apk: z.array(ToolEntrySchema).default([]),
    /** npm global packages */
    npm: z.array(ToolEntrySchema).default([]),
    /** Binaries to download via curl */
    curl: z.array(CurlBinarySchema).default([]),
  }).default({ apk: [], npm: [], curl: [] }),
}).strict();

export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

/** Candidate filenames searched for in order. */
const MANIFEST_CANDIDATES = [
  "workspace-manifest.json",
  "workspace-manifest.yaml",
  "workspace-manifest.yml",
];

/** Marker written when setup completes successfully. */
export const OFFICE_READY_MARKER = ".office-ready";

/**
 * Load and validate a workspace manifest from the given directory.
 * Returns null if no manifest is found.
 */
export function loadWorkspaceManifest(workspaceDir: string): WorkspaceManifest | null {
  for (const filename of MANIFEST_CANDIDATES) {
    const fullPath = join(workspaceDir, filename);
    if (!existsSync(fullPath)) continue;

    const raw = readFileSync(fullPath, "utf-8");
    const parsed = fullPath.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
    return WorkspaceManifestSchema.parse(parsed);
  }
  return null;
}

/**
 * Install a single APK package. Returns true on success.
 */
function installApk(pkg: string): boolean {
  const result = spawnSync("apk", ["add", "--no-cache", pkg], {
    stdio: "inherit",
    encoding: "utf-8",
  });
  return result.status === 0;
}

/**
 * Install a single npm global package. Returns true on success.
 */
function installNpm(pkg: string): boolean {
  const result = spawnSync("npm", ["install", "-g", "--prefer-offline", pkg], {
    stdio: "inherit",
    encoding: "utf-8",
  });
  return result.status === 0;
}

/**
 * Verify that a command is available on PATH.
 */
function commandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { encoding: "utf-8" });
  return result.status === 0;
}

/**
 * Run the Office Manager pipeline:
 * 1. Load workspace manifest.
 * 2. Install all declared tools (apk → npm → curl).
 * 3. Verify installations.
 * 4. Write `.office-ready` marker.
 *
 * @param workspaceDir - path to the agent workspace
 * @param options.dryRun - print what would be done without executing
 * @returns `true` if office is ready, `false` if any required install failed
 */
export async function runOfficeManager(
  workspaceDir: string,
  options: { dryRun?: boolean } = {}
): Promise<boolean> {
  const { dryRun = false } = options;

  const manifest = loadWorkspaceManifest(workspaceDir);
  if (!manifest) {
    // No manifest — nothing to install. Mark ready immediately.
    console.log("No workspace-manifest found. Office ready (no dependencies required).");
    if (!dryRun) {
      writeFileSync(join(workspaceDir, OFFICE_READY_MARKER), new Date().toISOString() + "\n");
    }
    return true;
  }

  console.log(`Office Manager: provisioning workspace '${manifest.name}'...`);

  let allOk = true;

  // --- APK packages ---
  for (const entry of manifest.tools.apk) {
    const pkg = typeof entry === "string" ? entry : entry.name;
    console.log(`  [apk] Installing ${pkg}...`);
    if (!dryRun) {
      const ok = installApk(pkg);
      if (!ok) {
        console.error(`  [apk] FAILED: ${pkg}`);
        allOk = false;
      }
    }
  }

  // --- npm globals ---
  for (const entry of manifest.tools.npm) {
    const pkg = typeof entry === "string" ? entry : `${entry.name}${entry.version ? `@${entry.version}` : ""}`;
    console.log(`  [npm] Installing ${pkg}...`);
    if (!dryRun) {
      const ok = installNpm(pkg);
      if (!ok) {
        console.error(`  [npm] FAILED: ${pkg}`);
        allOk = false;
      }
    }
  }

  // --- curl binaries ---
  for (const entry of manifest.tools.curl) {
    console.log(`  [curl] Downloading ${entry.url} → ${entry.dest}...`);
    if (!dryRun) {
      mkdirSync(join(entry.dest, "..").replace(/\/[^/]+$/, ""), { recursive: true });
      const dl = spawnSync(
        "curl",
        ["--fail", "--silent", "--location", "--output", entry.dest, entry.url],
        { stdio: "inherit", encoding: "utf-8" }
      );
      if (dl.status === 0) {
        spawnSync("chmod", [entry.chmod, entry.dest]);
      } else {
        console.error(`  [curl] FAILED: ${entry.url}`);
        allOk = false;
      }
    }
  }

  if (allOk) {
    console.log("Office Manager: all dependencies installed.");
    if (!dryRun) {
      writeFileSync(join(workspaceDir, OFFICE_READY_MARKER), new Date().toISOString() + "\n");
    }
    console.log(`Office Manager: wrote ${OFFICE_READY_MARKER} — office is ready.`);
  } else {
    console.error("Office Manager: some dependencies failed. Workspace is NOT fully provisioned.");
  }

  return allOk;
}
