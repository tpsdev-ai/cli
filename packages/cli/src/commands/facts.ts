/**
 * facts.ts — Facts Substrate S1: CLI command dispatcher
 * (ops-568p child)
 *
 * Handles all `tps facts <action>` commands.
 * Drift detection + cache update happens here (not in runVerify — Kern's boundary).
 */

import {
  readManifest,
  validateEntry,
  writeLocalSchema,
  removeLocalSchema,
  refreshManifestFromLocalSchemas,
  localSchemasPath,
  writeManifest,
  ensureFactsDir,
  type ManifestEntry,
  type FactType,
  type FactTtl,
  type FactsManifest,
} from "../utils/facts-manifest.js";

import {
  readCache,
  getCachedValue,
  setCachedValue,
  isCacheExpired,
  computeTtlExpiry,
  type CacheStatus,
} from "../utils/facts-cache.js";

import {
  runVerify,
  buildSpawnDescriptor,
} from "../utils/facts-verify.js";

import {
  discoverSchemas,
  resolveConflicts,
  isNamespaceAllowed,
  DEFAULT_ALLOWED_NAMESPACES,
  type DiscoveredSchema,
  type DiscoveryResult,
  type RefreshReport,
} from "../utils/facts-discovery.js";

import { appendFileSync } from "node:fs";
import { driftLogPath } from "../utils/facts-manifest.js";

// ---------------------------------------------------------------------------
// Drift logging
// ---------------------------------------------------------------------------

function logDrift(factName: string, cachedValue: unknown, liveValue: unknown, cmd: string): void {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    fact_name: factName,
    cached_value: cachedValue,
    live_value: liveValue,
    cmd,
  })}\n`;

  try {
    appendFileSync(driftLogPath(), line, { mode: 0o600 });
  } catch {
    // Best-effort — don't break the main flow over log failures
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function fmtValue(v: unknown): string {
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function formatJsonOutput(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

interface CmdArgs {
  action?: string;
  name?: string;
  scope?: string;
  json?: boolean;
  noVerify?: boolean;
  verifyPreview?: boolean;
  failOnDrift?: boolean;
  command?: string;
  parsedArgs?: string[];
  type?: string;
  ttl?: string;
  rationale?: string;
}

export async function runFacts(args: CmdArgs): Promise<void> {
  const { action } = args;

  switch (action) {
    case "list":
      await handleList(args);
      break;
    case "show":
      await handleShow(args);
      break;
    case "get":
      await handleGet(args);
      break;
    case "verify":
      await handleVerify(args);
      break;
    case "register":
      await handleRegister(args);
      break;
    case "unregister":
      await handleUnregister(args);
      break;
    case "init":
      await handleInit(args);
      break;
    case "refresh":
      await handleRefresh(args);
      break;
    case "schemas":
      await handleSchemas(args);
      break;
    case "which":
      await handleWhich(args);
      break;
    default:
      console.error("Usage: tps facts <list|show|get|verify|register|unregister|init|refresh|schemas|which>");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList(args: CmdArgs): Promise<void> {
  const manifest = readManifest();
  const cache = readCache();
  const scopeFilter = args.scope;

  const entries = Object.entries(manifest.facts)
    .filter(([, e]) => !scopeFilter || e.scope === scopeFilter || e.scope.startsWith(`${scopeFilter}.`))
    .sort(([a], [b]) => a.localeCompare(b));

  if (args.json) {
    const result = entries.map(([name, entry]) => {
      const cached = getCachedValue(cache, name);
      let cacheStatus: CacheStatus = "not_in_cache";
      if (cached) {
        cacheStatus = isCacheExpired(cached) ? "not_in_cache" : "fresh";
      }
      return {
        name,
        scope: entry.scope,
        type: entry.type,
        ttl: entry.ttl ?? "manual",
        cache_status: cacheStatus,
      };
    });
    formatJsonOutput({ facts: result });
    return;
  }

  if (entries.length === 0) {
    console.log("No facts declared. Use `tps facts register` to add one.");
    return;
  }

  for (const [name, entry] of entries) {
    const cached = getCachedValue(cache, name);
    let cacheStatus = "not_in_cache";
    if (cached) {
      cacheStatus = isCacheExpired(cached) ? "stale" : "fresh";
    }
    console.log(`${name} | ${entry.scope} | ${entry.type} | ${entry.ttl ?? "manual"} | ${cacheStatus}`);
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function handleShow(args: CmdArgs): Promise<void> {
  if (!args.name) {
    console.error("Usage: tps facts show <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  const entry = manifest.facts[args.name];
  if (!entry) {
    console.error(`Fact "${args.name}" not found. Run \`tps facts list\` to see declared facts.`);
    process.exit(2);
  }

  if (args.json) {
    formatJsonOutput({
      name: args.name,
      scope: entry.scope,
      type: entry.type,
      ttl: entry.ttl ?? "manual",
      priority: entry.priority ?? 0,
      version: entry.version,
      rationale: entry.rationale,
      remediation: entry.remediation_when_drift ?? null,
      verify_command: entry.verify.command,
      verify_args: entry.verify.args,
      verify_timeout_ms: entry.verify.timeout_ms ?? 10000,
      schema: entry.schema,
    });
    return;
  }

  console.log(`Name:       ${args.name}`);
  console.log(`Scope:      ${entry.scope}`);
  console.log(`Type:       ${entry.type}`);
  console.log(`TTL:        ${entry.ttl ?? "manual"}`);
  console.log(`Priority:   ${entry.priority ?? 0}`);
  console.log(`Version:    ${entry.version}`);
  console.log(`Rationale:  ${entry.rationale}`);
  if (entry.remediation_when_drift) {
    console.log(`Remediation: ${entry.remediation_when_drift}`);
  }
  console.log(`Schema:     ${entry.schema}`);
  console.log(`Verify:     ${entry.verify.command} ${entry.verify.args.join(" ")}`);
  console.log(`Timeout:    ${entry.verify.timeout_ms ?? 10000}ms`);
}

// ---------------------------------------------------------------------------
// get helpers (extracted for cognitive complexity)
// ---------------------------------------------------------------------------

/** Format and print a successful get result (fresh cache or fresh-verified). */
function printGetSuccess(args: CmdArgs, name: string, value: unknown, status: CacheStatus, verifiedAt: string): void {
  if (args.json) {
    formatJsonOutput({ name, value, cache_status: status, verifiedAt });
  } else {
    console.log(`${name} = ${fmtValue(value)} (${status}, verified ${verifiedAt})`);
  }
}

/** Handle drift detection, cache update, and output for a successful verify. */
function handleGetVerified(
  args: CmdArgs,
  name: string,
  entry: ManifestEntry,
  result: Extract<import("../utils/facts-verify.js").VerifyResult, { ok: true }>,
  cached: ReturnType<typeof getCachedValue>,
): void {
  const ttl = entry.ttl ?? "manual";
  const expiry = computeTtlExpiry(ttl as FactTtl);

  // Drift detection: compare against cached value
  if (cached) {
    const cachedStr = JSON.stringify(cached.value);
    const liveStr = JSON.stringify(result.value);
    if (cachedStr !== liveStr) {
      logDrift(name, cached.value, result.value, entry.verify.command);
      console.warn(`drift: ${name}`);
      console.warn(`  cached: ${fmtValue(cached.value)}`);
      console.warn(`  live:   ${fmtValue(result.value)}`);
    }
  }

  // Update cache
  setCachedValue(name, result.value, expiry);

  const status: CacheStatus = cached && JSON.stringify(cached.value) !== JSON.stringify(result.value)
    ? "drift_detected"
    : "fresh";

  printGetSuccess(args, name, result.value, status, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function handleGet(args: CmdArgs): Promise<void> {
  if (!args.name) {
    console.error("Usage: tps facts get <name>");
    process.exit(1);
  }
  const name = args.name;

  const manifest = readManifest();
  const entry = manifest.facts[name];
  if (!entry) {
    console.error(`Fact "${name}" not found. Run \`tps facts list\` to see declared facts.`);
    process.exit(2);
  }

  // --verify-preview: show spawn descriptor without executing
  if (args.verifyPreview) {
    const desc = buildSpawnDescriptor(entry);
    if (args.json) {
      formatJsonOutput(desc as unknown as Record<string, unknown>);
    } else {
      console.log(`Command: ${desc.command}`);
      console.log(`Args:    ${desc.args.join(" ")}`);
      console.log(`Env:     PATH=${desc.env.PATH} HOME=${desc.env.HOME} LANG=${desc.env.LANG}`);
      console.log(`CWD:     ${desc.cwd}`);
      console.log(`Timeout: ${desc.timeout_ms}ms`);
    }
    return;
  }

  // --no-verify: return cached value without running verify
  if (args.noVerify) {
    const cache = readCache();
    const cached = getCachedValue(cache, name);
    if (!cached) {
      console.error(`No cached value for "${name}". Run without --no-verify to verify.`);
      process.exit(3);
    }
    printGetSuccess(args, name, cached.value, "no_verify_flag", cached.verifiedAt);
    return;
  }

  // Check cache freshness
  const cache = readCache();
  const cached = getCachedValue(cache, name);
  if (cached && !isCacheExpired(cached)) {
    printGetSuccess(args, name, cached.value, "fresh", cached.verifiedAt);
    return;
  }

  // Run verify
  const result = await runVerify(entry);

  if (result.ok) {
    handleGetVerified(args, name, entry, result, cached);
    return;
  }

  // Verify failed
  const reason = result.reason;
  if (cached) {
    const status: CacheStatus = `verify_failed_${reason}` as CacheStatus;
    printGetSuccess(args, name, cached.value, status, cached.verifiedAt);
  } else {
    console.error(`Fact "${name}" verify failed (${reason}): ${result.detail}`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function handleVerify(args: CmdArgs): Promise<void> {
  const manifest = readManifest();
  const scopeFilter = args.scope;

  const entries = Object.entries(manifest.facts)
    .filter(([, e]) => !scopeFilter || e.scope === scopeFilter || e.scope.startsWith(`${scopeFilter}.`));

  if (entries.length === 0) {
    console.log("No facts to verify.");
    return;
  }

  let verified = 0;
  let drifted = 0;
  let failed = 0;
  const driftReports: string[] = [];
  const failureReports: string[] = [];

  const cache = readCache();

  for (const [name, entry] of entries) {
    const result = await runVerify(entry);

    if (result.ok) {
      verified++;
      const cached = getCachedValue(cache, name);

      if (cached && JSON.stringify(cached.value) !== JSON.stringify(result.value)) {
        drifted++;
        driftReports.push(`  drift: ${name}`);
        driftReports.push(`   cached: ${fmtValue(cached.value)}`);
        driftReports.push(`   live: ${fmtValue(result.value)}`);

        logDrift(name, cached.value, result.value, entry.verify.command);
      }

      // Update cache regardless
      const ttl = entry.ttl ?? "manual";
      const expiry = computeTtlExpiry(ttl as FactTtl);
      setCachedValue(name, result.value, expiry);
    } else {
      failed++;
      failureReports.push(`  verify_failed: ${name} (reason: ${result.reason}, detail: ${result.detail})`);
    }
  }

  // Summary
  console.log(`${verified} facts verified, ${drifted} drift detected, ${failed} verify-failed`);

  for (const line of driftReports) {
    console.log(line);
  }
  for (const line of failureReports) {
    console.log(line);
  }

  if (args.failOnDrift && drifted > 0) {
    process.exit(4);
  }
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

async function handleRegister(args: CmdArgs): Promise<void> {
  if (!args.name) {
    console.error("Usage: tps facts register <name> --command <cmd> --args <json-array> --type <t> [--ttl <ttl>] [--scope <s>] --rationale <text>");
    process.exit(1);
  }

  // Validate required fields
  if (!args.command) {
    console.error("--command is required");
    process.exit(1);
  }

  if (!args.parsedArgs) {
    console.error('--args is required (JSON array, e.g. --args \'["a","b"]\')');
    process.exit(1);
  }

  if (!args.type) {
    console.error("--type is required");
    process.exit(1);
  }

  if (!args.rationale) {
    console.error("--rationale is required");
    process.exit(1);
  }

  const manifest = readManifest();
  const schemaVersion = (manifest.facts[args.name]?.version ?? 0) + 1;

  const entry: ManifestEntry = {
    schema: `local:${localSchemasPath(args.name)}:${schemaVersion}`,
    verify: {
      command: args.command,
      args: args.parsedArgs,
      timeout_ms: 10000,
    },
    type: args.type as FactType,
    ttl: (args.ttl || "manual") as FactTtl,
    scope: args.scope || "local",
    version: schemaVersion,
    priority: 0,
    rationale: args.rationale,
  };

  // Validate entry
  const errors = validateEntry(entry, args.name);
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`Validation error: ${err.field}: ${err.message}`);
    }
    process.exit(1);
  }

  // Write local schema file
  writeLocalSchema(args.name, entry);

  // Refresh manifest
  refreshManifestFromLocalSchemas();

  console.log(`Registered fact "${args.name}" (type=${entry.type}, scope=${entry.scope})`);
}

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

async function handleUnregister(args: CmdArgs): Promise<void> {
  if (!args.name) {
    console.error("Usage: tps facts unregister <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  const entry = manifest.facts[args.name];

  if (!entry) {
    console.error(`Fact "${args.name}" not found.`);
    process.exit(1);
  }

  // Only allow unregistering local-schema facts
  if (!entry.schema.startsWith("local:")) {
    console.error(`Cannot unregister "${args.name}" — it is not a local fact (schema: ${entry.schema}).`);
    console.error("Package-shipped facts must be removed by uninstalling or updating the package.");
    process.exit(1);
  }

  const removed = removeLocalSchema(args.name);
  if (!removed) {
    console.error(`Local schema file for "${args.name}" does not exist.`);
    process.exit(1);
  }

  // Refresh manifest
  refreshManifestFromLocalSchemas();

  console.log(`Unregistered fact "${args.name}"`);
}

// ---------------------------------------------------------------------------
// S2: init — First-run discovery
// ---------------------------------------------------------------------------

async function handleInit(args: CmdArgs): Promise<void> {
  const strictMode = process.argv.includes("--strict");
  const allowlist = strictMode ? [] : DEFAULT_ALLOWED_NAMESPACES;

  const result = discoverSchemas(process.cwd(), {
    allowlist: strictMode ? undefined : allowlist,
    strict: strictMode,
  });

  // Load existing manifest to merge
  const existing = readManifest();
  const existingFacts = existing.facts ?? {};

  // Merge discovered entries into manifest (idempotent)
  const manifest: FactsManifest = {
    version: 1,
    facts: { ...existingFacts }, // preserve local-schema entries
    registeredAt: new Date().toISOString(),
  };

  let newCount = 0;
  const conflictMap = new Map<string, DiscoveredSchema[]>();
  for (const disc of result.discovered) {
    const name = disc.name ?? disc.relPath.replace(".json", "");
    // Idempotent: don't duplicate if already present with same schema
    if (existingFacts[name] && existingFacts[name].schema === disc.entry.schema) {
      continue;
    }

    // Track potential conflicts
    if (!conflictMap.has(name)) conflictMap.set(name, []);
    conflictMap.get(name)!.push(disc);

    // If not yet in manifest, add it
    if (!manifest.facts[name]) {
      manifest.facts[name] = disc.entry;
      newCount++;
    } else {
      // Conflict resolution: higher priority wins
      const existing = manifest.facts[name];
      const discPriority = disc.entry.priority ?? 0;
      const existingPriority = existing.priority ?? 0;
      if (discPriority > existingPriority ||
          (discPriority === existingPriority && disc.relPath < (existing.schema ?? ""))) {
        manifest.facts[name] = disc.entry;
      }
    }
  }

  // Report conflict warnings
  for (const [name, decls] of conflictMap) {
    if (decls.length > 1) {
      console.warn(`conflict: "${name}" declared in ${decls.length} schemas — ` +
        `winner: ${manifest.facts[name]?.schema}`);
    }
  }

  writeManifest(manifest);

  if (args.json) {
    const schemaList = result.discovered.map(d => ({
      schema: `${d.package}@${d.version}/${d.relPath}`,
      name: d.name,
    }));
    console.log(JSON.stringify({
      discovered: result.discovered.length,
      schemas: schemaList,
      facts: Object.keys(manifest.facts).length,
    }, null, 2));
    return;
  }

  console.log(`Initialized facts manifest.`);
  console.log(`  Discovered: ${result.discovered.length} schemas`);
  console.log(`  Facts: ${Object.keys(manifest.facts).length}`);

  if (result.errors.length > 0) {
    console.warn(`  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      console.warn(`    ${err.package}: ${err.reason}`);
    }
    if (result.errors.length > 5) {
      console.warn(`    ... and ${result.errors.length - 5} more`);
    }
  }
}

// ---------------------------------------------------------------------------
// S2: refresh — Re-discover and merge
// ---------------------------------------------------------------------------

async function handleRefresh(args: CmdArgs): Promise<void> {
  const strictMode = process.argv.includes("--strict");
  const allowlist = strictMode ? [] : DEFAULT_ALLOWED_NAMESPACES;

  const result = discoverSchemas(process.cwd(), {
    allowlist: strictMode ? undefined : allowlist,
    strict: strictMode,
  });

  const existing = readManifest();
  const oldKeys = new Set(Object.keys(existing.facts));
  const discoveredKeys = new Set<string>();

  // Build discovered set
  const discoveredByName = new Map<string, DiscoveredSchema[]>();
  for (const disc of result.discovered) {
    const name = disc.name ?? disc.relPath.replace(".json", "");
    discoveredKeys.add(name);
    if (!discoveredByName.has(name)) discoveredByName.set(name, []);
    discoveredByName.get(name)!.push(disc);
  }

  const report: RefreshReport = { added: [], updated: [], removed: [] };
  const newFacts: Record<string, ManifestEntry> = {};

  // First pass: copy local-schema facts (they weren't discovered)
  for (const [name, entry] of Object.entries(existing.facts)) {
    if (entry.schema.startsWith("local:")) {
      newFacts[name] = entry;
    }
  }

  // Second pass: merge discovered facts
  for (const [name, decls] of discoveredByName) {
    // Conflict resolution: highest priority wins
    const sorted = decls.map(d => ({
      entry: d.entry,
      priority: d.entry.priority ?? 0,
      relPath: d.relPath,
    })).sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.relPath.localeCompare(b.relPath);
    });

    const winner = sorted[0].entry;
    newFacts[name] = winner;

    if (!oldKeys.has(name)) {
      report.added.push(name);
    } else if (JSON.stringify(existing.facts[name]) !== JSON.stringify(winner)) {
      report.updated.push(name);
    }
  }

  // Third pass: detect removed (in old but not in discovered and not local)
  for (const name of oldKeys) {
    if (!discoveredKeys.has(name) && !existing.facts[name].schema.startsWith("local:")) {
      report.removed.push(name);
    }
  }

  const manifest: FactsManifest = {
    version: 1,
    facts: newFacts,
    registeredAt: new Date().toISOString(),
  };

  writeManifest(manifest);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Refreshed facts manifest.`);
  console.log(`  Added: ${report.added.length}  Updated: ${report.updated.length}  Removed: ${report.removed.length}`);

  for (const name of report.added) console.log(`  + ${name}`);
  for (const name of report.updated) console.log(`  ~ ${name}`);
  for (const name of report.removed) console.log(`  - ${name}`);
}

// ---------------------------------------------------------------------------
// S2: schemas — List discovered schemas with provenance
// ---------------------------------------------------------------------------

async function handleSchemas(args: CmdArgs): Promise<void> {
  const result = discoverSchemas(process.cwd());

  if (args.json) {
    const list = result.discovered.map(d => ({
      package: d.package,
      version: d.version,
      file: d.relPath,
      fact_name: d.name,
      scope: d.entry.scope,
      type: d.entry.type,
    }));
    console.log(JSON.stringify({ schemas: list }, null, 2));
    return;
  }

  if (result.discovered.length === 0) {
    console.log("No discovered schemas.");
    return;
  }

  // Aggregated by package+file for the table
  const agg = new Map<string, { pkg: string; ver: string; file: string; count: number }>();
  for (const d of result.discovered) {
    const key = `${d.package}/${d.relPath}`;
    if (!agg.has(key)) {
      agg.set(key, { pkg: d.package, ver: d.version, file: d.relPath, count: 0 });
    }
    agg.get(key)!.count++;
  }

  // Render table: Pkg, Version, File, Facts
  const rows = Array.from(agg.values()).map(a => [a.pkg, a.ver, a.file, String(a.count)]);
  const cols = ["Package", "Version", "File", "Facts"];
  const widths = cols.map((_, i) =>
    Math.max(cols[i].length, ...rows.map(r => (r[i] ?? "").length))
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  console.log(cols.map((c, i) => pad(c, widths[i])).join("  "));
  console.log(widths.map(w => "─".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// S2: which — Show which schema declared a fact + conflict resolution chain
// ---------------------------------------------------------------------------

async function handleWhich(args: CmdArgs): Promise<void> {
  if (!args.name) {
    console.error("Usage: tps facts which <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  const winnerEntry = manifest.facts[args.name];

  if (!winnerEntry) {
    console.error(`Fact "${args.name}" not found in manifest.`);
    process.exit(1);
  }

  // Discover to find all declarations
  const result = discoverSchemas(process.cwd());
  const conflicts = resolveConflicts(result.discovered);

  // Find the conflict for this fact name
  const conflict = conflicts.find(c => c.factName === args.name);

  if (args.json) {
    if (conflict) {
      console.log(JSON.stringify({
        name: args.name,
        declarations: conflict.declarations.map(d => ({
          package: d.package,
          version: d.version,
          path: d.relPath,
          priority: d.priority,
          is_winner: d.isWinner,
        })),
        winner_schema: winnerEntry.schema,
      }, null, 2));
    } else {
      console.log(JSON.stringify({
        name: args.name,
        declarations: [{
          schema: winnerEntry.schema,
          priority: winnerEntry.priority ?? 0,
          is_winner: true,
        }],
        winner_schema: winnerEntry.schema,
      }, null, 2));
    }
    return;
  }

  console.log(`Fact: ${args.name}`);
  console.log(`Winner: ${winnerEntry.schema}`);
  console.log(`Priority: ${winnerEntry.priority ?? 0}`);

  if (conflict && conflict.declarations.length > 1) {
    console.log(`\nConflict chain (${conflict.declarations.length} declarations):`);
    for (const d of conflict.declarations) {
      const marker = d.isWinner ? "→ WINNER" : "  (shadowed)";
      console.log(`  ${d.package}@${d.version}/${d.relPath}  priority=${d.priority}  ${marker}`);
    }
  } else {
    console.log(`\nNo conflicts — single declaration from ${winnerEntry.schema}`);
  }
}
