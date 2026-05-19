/**
 * facts-manifest.ts — Facts Substrate S1: Manifest I/O + validators + types
 * (ops-568p child)
 *
 * Pure module. Manifest file: ~/.tps/facts/index.json (mode 0600).
 * Directory: ~/.tps/facts/ (mode 0700).
 * Local schemas: ~/.tps/facts/local-schemas/*.json (mode 0600 each).
 *
 * Atomic writes: temp file + rename for both manifest and cache.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Home directory resolution
// TPS_HOME env var overrides for testing; falls back to HOME → os.homedir()
// ---------------------------------------------------------------------------

function resolveHome(): string {
  return process.env.TPS_HOME ?? process.env.HOME ?? homedir();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function factsDir(): string {
  return join(resolveHome(), ".tps", "facts");
}

export function manifestPath(): string {
  return join(factsDir(), "index.json");
}

export function localSchemasDir(): string {
  return join(factsDir(), "local-schemas");
}

export function localSchemasPath(name: string): string {
  return join(localSchemasDir(), `${name}.json`);
}

export function cachePath(): string {
  return join(factsDir(), "cache.json");
}

export function driftLogPath(): string {
  return join(factsDir(), "drift.log");
}

// ---------------------------------------------------------------------------
// Atomic write utility
// ---------------------------------------------------------------------------

/**
 * Write content to file atomically: temp file + rename.
 * Creates parent directories if they don't exist.
 * Sets the given mode on the final file.
 */
export function atomicWrite(filePath: string, content: string, mode: number = 0o600): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmpPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, { mode });
  renameSync(tmpPath, filePath);
}

/**
 * Ensure the facts directory tree exists with correct permissions.
 */
export function ensureFactsDir(): void {
  const dir = factsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(localSchemasDir(), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactType = "string" | "int" | "bool" | "json";

export type FactTtl = "manual" | "30s" | "1m" | "5m" | "1h" | "1d" | "7d";

export interface ManifestEntry {
  schema: string;
  verify: {
    command: string;
    args: string[];
    timeout_ms?: number;
  };
  type: FactType;
  ttl?: FactTtl;
  scope: string;
  version: number;
  priority?: number;
  rationale: string;
  remediation_when_drift?: string;
}

export interface FactsManifest {
  version: 1;
  facts: Record<string, ManifestEntry>;
  registeredAt: string;
}

/**
 * The shell blocklist from Appendix B. These commands MUST NOT be used
 * as verify.command — validators reject them on load and on write.
 *
 * This blocklist is a coarse guardrail. The real security boundary is
 * schema PR review + the verify contract (deterministic, side-effect-free).
 * Intentional arbitrary execution via python3 -c, perl -e, node -e, awk,
 * sed -e, etc. is functionally identical to sh -c and cannot be enumerated
 * by a validator.
 */
export const SHELL_BLOCKLIST: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh", "csh",
  "tcsh", "ash", "bsh", "ion", "nu", "oil",
  "pwsh", "powershell", "xonsh", "yash",
]);

export const VALID_TTL_VALUES: ReadonlySet<string> = new Set([
  "manual", "30s", "1m", "5m", "1h", "1d", "7d",
]);

export const VALID_TYPES: ReadonlySet<string> = new Set([
  "string", "int", "bool", "json",
]);

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a single ManifestEntry. Returns an array of ValidationErrors
 * (empty = valid). Non-destructive — never throws.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear field validation — clean set of if-checks, not deeply nested
export function validateEntry(entry: unknown, name: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!entry || typeof entry !== "object") {
    errors.push({ field: "entry", message: `fact "${name}" is not an object` });
    return errors;
  }

  const e = entry as Record<string, unknown>;

  // verify.command must be a string and not on the shell blocklist
  if (typeof e.verify !== "object" || !e.verify) {
    errors.push({ field: "verify", message: `"verify" must be an object` });
  } else {
    const v = e.verify as Record<string, unknown>;
    if (typeof v.command !== "string") {
      errors.push({ field: "verify.command", message: `"verify.command" must be a string` });
    } else if (SHELL_BLOCKLIST.has(v.command)) {
      errors.push({ field: "verify.command", message: `"${v.command}" is a shell (blocklisted). Use absolute paths for non-core binaries.` });
    }

    // verify.args must be an array of strings
    if (!Array.isArray(v.args)) {
      errors.push({ field: "verify.args", message: `"verify.args" must be an array` });
    } else {
      for (let i = 0; i < v.args.length; i++) {
        if (typeof v.args[i] !== "string") {
          errors.push({ field: `verify.args[${i}]`, message: `element ${i} is not a string` });
        }
      }
    }

    // verify.timeout_ms in [100, 60000] if present
    if (v.timeout_ms !== undefined) {
      if (typeof v.timeout_ms !== "number" || !Number.isInteger(v.timeout_ms)) {
        errors.push({ field: "verify.timeout_ms", message: "must be an integer" });
      } else if (v.timeout_ms < 100 || v.timeout_ms > 60000) {
        errors.push({ field: "verify.timeout_ms", message: "must be in [100, 60000]" });
      }
    }
  }

  // type must be in VALID_TYPES
  if (typeof e.type !== "string" || !VALID_TYPES.has(e.type)) {
    errors.push({ field: "type", message: `must be one of: ${[...VALID_TYPES].join(", ")}` });
  }

  // ttl must be in VALID_TTL_VALUES if present
  if (e.ttl !== undefined) {
    if (typeof e.ttl !== "string" || !VALID_TTL_VALUES.has(e.ttl)) {
      errors.push({ field: "ttl", message: `must be one of: ${[...VALID_TTL_VALUES].join(", ")}` });
    }
  }

  // rationale must be non-empty string
  if (typeof e.rationale !== "string" || e.rationale.trim().length === 0) {
    errors.push({ field: "rationale", message: "must be a non-empty string" });
  }

  // schema must be present (for S1: "local:<path>:<version>")
  if (typeof e.schema !== "string" || e.schema.length === 0) {
    errors.push({ field: "schema", message: "must be a non-empty string" });
  }

  // scope must be a string
  if (typeof e.scope !== "string") {
    errors.push({ field: "scope", message: "must be a string" });
  }

  // version must be a positive integer
  if (typeof e.version !== "number" || !Number.isInteger(e.version) || e.version < 1) {
    errors.push({ field: "version", message: "must be a positive integer" });
  }

  // priority defaults to 0 if absent (Kern: added to S1 manifest to avoid migration in S2)
  if (e.priority !== undefined && (typeof e.priority !== "number" || !Number.isInteger(e.priority))) {
    errors.push({ field: "priority", message: "must be an integer" });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/**
 * Read the facts manifest. Returns a default empty manifest if the file
 * doesn't exist. Returns empty manifest (with warnings logged to stderr)
 * if the file is malformed.
 */
export function readManifest(): FactsManifest {
  const p = manifestPath();
  const defaultManifest: FactsManifest = { version: 1, facts: {}, registeredAt: "" };

  if (!existsSync(p)) {
    return defaultManifest;
  }

  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || parsed.version !== 1) {
      console.warn(`facts: manifest at ${p} has unknown version, treating as empty`);
      return defaultManifest;
    }

    const facts: Record<string, ManifestEntry> = {};
    const rawFacts = parsed.facts ?? {};

    for (const [name, entry] of Object.entries(rawFacts)) {
      const errors = validateEntry(entry, name);
      if (errors.length > 0) {
        for (const err of errors) {
          console.warn(`facts: skipping "${name}" — ${err.field}: ${err.message}`);
        }
        continue;
      }
      facts[name] = entry as ManifestEntry;
    }

    return { version: 1, facts, registeredAt: parsed.registeredAt ?? "" };
  } catch (err) {
    console.warn(`facts: failed to read manifest at ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return defaultManifest;
  }
}

/**
 * Write the facts manifest atomically.
 */
export function writeManifest(manifest: FactsManifest): void {
  ensureFactsDir();
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  atomicWrite(manifestPath(), content, 0o600);
}

/**
 * Read a local-schema file by name. Returns the parsed JSON object
 * or null if the file doesn't exist / is malformed.
 */
export function readLocalSchema(name: string): ManifestEntry | null {
  const p = localSchemasPath(name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as ManifestEntry;
  } catch {
    return null;
  }
}

/**
 * Write a local-schema file atomically (for `tps facts register`).
 */
export function writeLocalSchema(name: string, entry: ManifestEntry): void {
  ensureFactsDir();
  const content = `${JSON.stringify(entry, null, 2)}\n`;
  atomicWrite(localSchemasPath(name), content, 0o600);
}

/**
 * Remove a local-schema file. Returns true if the file was removed,
 * false if it didn't exist.
 */
export function removeLocalSchema(name: string): boolean {
  const p = localSchemasPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/**
 * Rebuild the manifest from local-schemas directory.
 * Reads all local-schema files and writes them into the manifest index.
 * This is called by `register` and `unregister` to sync the manifest.
 */
export function refreshManifestFromLocalSchemas(): FactsManifest {
  ensureFactsDir();
  const manifest = readManifest();

  // Clear existing facts (we'll rebuild from local schemas)
  // In S2, package-shipped facts are preserved during refresh.
  const newFacts: Record<string, ManifestEntry> = {};

  const schemasDir = localSchemasDir();
  if (existsSync(schemasDir)) {
    const files = readdirSync(schemasDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5); // strip .json
      const entry = readLocalSchema(name);
      if (entry) {
        const errors = validateEntry(entry, name);
        if (errors.length === 0) {
          newFacts[name] = entry;
        }
      }
    }
  }

  manifest.facts = newFacts;
  manifest.registeredAt = new Date().toISOString();
  writeManifest(manifest);
  return manifest;
}
