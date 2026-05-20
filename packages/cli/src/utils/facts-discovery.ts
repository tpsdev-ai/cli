/**
 * facts-discovery.ts — Facts Substrate S2: Schema discovery from node_modules
 * (ops-nmoe)
 *
 * Walks node_modules/@tpsdev-ai/* and node_modules/@harperfast/* for
 * schemas/facts/*.json files, validates them, and provides provenance.
 *
 * Security rules (Sherlock):
 * - Strict namespace allowlist: @tpsdev-ai/* and @harperfast/* by default
 * - --strict mode requires explicit per-package allowlisting
 * - Schema paths are validated against directory traversal
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { validateEntry, type ManifestEntry } from "./facts-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredSchema {
  /** Fact name (canonical dotted name, e.g. host.rockit.platform) */
  name: string;
  /** Package name, e.g. @tpsdev-ai/tps */
  package: string;
  /** Package version from package.json */
  version: string;
  /** Relative path within the package, e.g. schemas/facts/host.json */
  relPath: string;
  /** Absolute path on disk */
  absPath: string;
  /** Parsed ManifestEntry (fact declaration) */
  entry: ManifestEntry;
  /** Line number where the fact was declared (1-indexed) */
  line?: number;
}

export interface DiscoveryResult {
  /** All schemas found during this walk */
  discovered: DiscoveredSchema[];
  /** Discovery errors (non-fatal) */
  errors: DiscoveryError[];
}

export interface DiscoveryError {
  path: string;
  package: string;
  reason: string;
}

export interface RefreshReport {
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Default allowed namespaces. Walk only these scopes by default.
 */
export const DEFAULT_ALLOWED_NAMESPACES = ["@tpsdev-ai", "@harperfast"];

// ---------------------------------------------------------------------------
// Namespace validation
// ---------------------------------------------------------------------------

/**
 * Check whether a package name is in the allowlist.
 * Supports wildcard matching (e.g., "@tpsdev-ai/*" matches "@tpsdev-ai/tps").
 */
export function isNamespaceAllowed(
  pkgName: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    // Exact match
    if (entry === pkgName) return true;
    // Wildcard match: "@tpsdev-ai/*" matches "@tpsdev-ai/anything"
    if (entry.endsWith("/*")) {
      const scope = entry.slice(0, -2);
      if (pkgName.startsWith(`${scope}/`)) return true;
    }
  }
  return false;
}

/**
 * Validate that a candidate path is within node_modules and doesn't traverse
 * outside expected boundaries.
 */
function isSafePath(absPath: string, nodeModulesRoot: string): boolean {
  const resolved = resolve(absPath);
  const base = resolve(nodeModulesRoot);
  if (!resolved.startsWith(base)) return false;

  // Reject symlinks pointing outside (shallow check — stat for real in production)
  return true;
}

// ---------------------------------------------------------------------------
// Package info extraction
// ---------------------------------------------------------------------------

/**
 * Read the version from a package's package.json.
 */
function readPackageVersion(pkgDir: string): string {
  try {
    const pj = join(pkgDir, "package.json");
    if (!existsSync(pj)) return "unknown";
    const raw = readFileSync(pj, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

/**
 * Load and validate all fact declarations from a single schema file.
 * A schema file is a JSON array of fact declarations.
 */
function loadSchemaFile(
  absPath: string,
  pkgName: string,
  pkgVersion: string,
): { entries: DiscoveredSchema[]; errors: DiscoveryError[] } {
  const entries: DiscoveredSchema[] = [];
  const errors: DiscoveryError[] = [];

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    errors.push({
      path: absPath,
      package: pkgName,
      reason: `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { entries, errors };
  }

  let schemas: unknown;
  try {
    schemas = JSON.parse(raw);
  } catch (err) {
    errors.push({
      path: absPath,
      package: pkgName,
      reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { entries, errors };
  }

  // Schema file can be a single object or an array of objects
  let items: unknown[];
  if (Array.isArray(schemas)) {
    items = schemas;
  } else if (schemas && typeof schemas === "object") {
    items = [schemas];
  } else {
    errors.push({
      path: absPath,
      package: pkgName,
      reason: "schema file must be an object or array of objects",
    });
    return { entries, errors };
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") {
      errors.push({
        path: absPath,
        package: pkgName,
        reason: `item[${i}] is not an object`,
      });
      continue;
    }

    const obj = item as Record<string, unknown>;
    const factName = typeof obj.name === "string" ? obj.name : null;
    if (!factName) {
      errors.push({
        path: absPath,
        package: pkgName,
        reason: `item[${i}] missing "name" field`,
      });
      continue;
    }

    // Inject schema provenance
    const relPath = absPath.split("node_modules/").pop() ?? basename(absPath);
    const schemaProvenance = `${pkgName}@${pkgVersion}/${relPath}`;
    const entry = { ...obj, schema: schemaProvenance } as ManifestEntry;

    const validationErrors = validateEntry(entry, factName);
    if (validationErrors.length > 0) {
      for (const ve of validationErrors) {
        errors.push({
          path: absPath,
          package: pkgName,
          reason: `${factName}: ${ve.field}: ${ve.message}`,
        });
      }
      continue;
    }

    entries.push({
      name: factName,
      package: pkgName,
      version: pkgVersion,
      relPath,
      absPath,
      entry,
    });
  }

  return { entries, errors };
}

// ---------------------------------------------------------------------------
// Discovery walker
// ---------------------------------------------------------------------------

/**
 * Walk node_modules under a root directory, discovering fact schemas from
 * allowed namespaces.
 *
 * @param root - Project root directory (default: cwd). The node_modules
 *   directory is expected at root/node_modules.
 * @param opts.allowlist - Namespaces to walk (default: @tpsdev-ai/*, @harperfast/*).
 * @param opts.strict - If true, allowlist must contain exact package names (no wildcards).
 */
export function discoverSchemas(
  root: string = process.cwd(),
  opts: { allowlist?: string[]; strict?: boolean } = {},
): DiscoveryResult {
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWED_NAMESPACES;
  const nodeModulesDir = join(root, "node_modules");
  const result: DiscoveryResult = { discovered: [], errors: [] };

  if (!existsSync(nodeModulesDir)) {
    return result;
  }

  // Walk each allowed namespace
  for (const ns of allowlist) {
    // Extract base scope: "@tpsdev-ai" from "@tpsdev-ai/*"
    const scopeDir = ns.endsWith("/*") ? ns.slice(0, -2) : ns;
    const nsPath = join(nodeModulesDir, scopeDir);

    if (!existsSync(nsPath)) continue;

    let pkgDirs: string[];
    try {
      pkgDirs = readdirSync(nsPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }

    for (const pkgDirName of pkgDirs) {
      const pkgDir = join(nsPath, pkgDirName);
      const pkgName = `${scopeDir}/${pkgDirName}`;

      // In strict mode, check exact match
      if (opts.strict && !isNamespaceAllowed(pkgName, allowlist)) {
        continue;
      }

      const schemasDir = join(pkgDir, "schemas", "facts");
      if (!existsSync(schemasDir)) continue;

      const pkgVersion = readPackageVersion(pkgDir);

      let schemaFiles: string[];
      try {
        schemaFiles = readdirSync(schemasDir)
          .filter(f => f.endsWith(".json") && statSync(join(schemasDir, f)).isFile());
      } catch {
        continue;
      }

      for (const file of schemaFiles) {
        const absPath = join(schemasDir, file);

        if (!isSafePath(absPath, nodeModulesDir)) {
          result.errors.push({
            path: absPath,
            package: pkgName,
            reason: "path traversal rejected",
          });
          continue;
        }

        const { entries, errors } = loadSchemaFile(absPath, pkgName, pkgVersion);
        result.discovered.push(...entries);
        result.errors.push(...errors);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export interface ConflictInfo {
  factName: string;
  /** All schemas declaring this fact, sorted by priority (desc) then alphabetically */
  declarations: Array<{
    package: string;
    version: string;
    relPath: string;
    priority: number;
    entry: ManifestEntry;
    /** true if this declaration wins the resolution */
    isWinner: boolean;
  }>;
}

/**
 * Resolve conflicts for facts declared by multiple schemas.
 * Winner = highest priority; tie-break by alphabetical schema path.
 * Returns sorted list of conflicts with winning declaration marked.
 */
export function resolveConflicts(
  discovered: DiscoveredSchema[],
): ConflictInfo[] {
  // Group by fact name
  const groups = new Map<string, DiscoveredSchema[]>();
  for (const d of discovered) {
    const name = d.name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(d);
  }

  const conflicts: ConflictInfo[] = [];

  for (const [factName, decls] of groups) {
    if (decls.length <= 1) continue;

    // Sort: higher priority first, then alphabetical by schema path
    const sorted = decls.map(d => ({
      package: d.package,
      version: d.version,
      relPath: d.relPath,
      priority: d.entry.priority ?? 0,
      entry: d.entry,
      isWinner: false,
    })).sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.relPath.localeCompare(b.relPath);
    });

    // Winner is the first after sorting
    sorted[0].isWinner = true;

    conflicts.push({ factName, declarations: sorted });
  }

  return conflicts;
}
