/**
 * secrets.ts — Cred Substrate S1+S2 secrets command
 *
 * Extends the vault-based secrets commands with credential manifest operations:
 *   list (manifest-aware), show, emit, register, unregister, adopt, verify, scan
 */

import { loadFromVault, TpsVault } from "../utils/identity.js";
import {
  readManifest,
  writeManifest,
  expandPath,
  manifestPath,
  CredentialsManifest,
  CredentialEntry,
  CredentialType,
  RESERVED_TYPES,
  sensitivityForType,
  VerifyResult,
  VerifyIssue,
  verifyAll,
  verifyFixAll,
  verifyEntry,
  verifySummary,
  filterExpiresWithin,
  filterByScope,
  filterByType,
  filterStaleOnly,
  isEntryStale,
  entryAge,
  walkAdoptCandidates,
  scanOrphans,
  adoptSingle,
  AdoptResult,
  AdoptCandidate,
  inferTypeFromPath,
  inferOwnerFromName,
} from "../utils/credentials-manifest.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// CLI entry point types
// ---------------------------------------------------------------------------

export type SecretsAction =
  | "set" | "list" | "remove"       // vault (legacy)
  | "show" | "emit"                 // manifest read
  | "register" | "unregister"       // manifest write
  | "adopt"                         // bulk scan + propose
  | "adopt-single"                  // adopt a single candidate
  | "verify"                        // check manifest integrity
  | "scan";                          // detect orphans

export interface SecretsArgs {
  action: SecretsAction;
  // vault
  key?: string;
  value?: string;
  // list filtering
  owner?: string;
  expiresWithin?: string;
  scope?: string;
  type?: string;
  staleOnly?: boolean;
  // register
  registerPath?: string;
  registerType?: string;
  registerOwner?: string;
  registerScope?: string;
  registerExpires?: string;
  registerSensitivity?: string;
  // adopt
  adoptApply?: boolean;
  adoptNonInteractive?: boolean;
  adoptSecretsDir?: string;
  adoptIdentityDir?: string;
  adoptFlairKeysDir?: string;
  // verify
  verifyFix?: boolean;
  failOnDrift?: boolean;
  // scan
  scanRoot?: string;
  // common
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function runSecrets(args: SecretsArgs): Promise<void> {
  switch (args.action) {
    case "set":
      await handleVaultSet(args);
      break;
    case "list":
      await handleList(args);
      break;
    case "remove":
      await handleVaultRemove(args);
      break;
    case "show":
      handleShow(args);
      break;
    case "emit":
      handleEmit(args);
      break;
    case "register":
      handleRegister(args);
      break;
    case "unregister":
      handleUnregister(args);
      break;
    case "adopt":
      handleAdopt(args);
      break;
    case "adopt-single":
      handleAdoptSingle(args);
      break;
    case "verify":
      handleVerify(args);
      break;
    case "scan":
      handleScan(args);
      break;
  }
}

// ---------------------------------------------------------------------------
// Vault operations (legacy)
// ---------------------------------------------------------------------------

async function handleVaultSet(args: SecretsArgs): Promise<void> {
  const vault = await loadFromVault();
  if (!vault) {
    console.error("No vault found. Run `tps identity init` first.");
    process.exit(1);
  }
  if (!args.key || args.value === undefined) {
    console.error("Usage: tps secrets set <KEY>=<VALUE>");
    process.exit(1);
  }
  vault.secrets[args.key] = args.value;
  const { saveToVault } = await import("../utils/identity.js");
  await saveToVault(vault);
  console.log(`Secret '${args.key}' updated.`);
}

async function handleVaultRemove(args: SecretsArgs): Promise<void> {
  const vault = await loadFromVault();
  if (!vault) {
    console.error("No vault found. Run `tps identity init` first.");
    process.exit(1);
  }
  if (!args.key) {
    console.error("Usage: tps secrets remove <KEY>");
    process.exit(1);
  }
  if (vault.secrets[args.key]) {
    delete vault.secrets[args.key];
    const { saveToVault } = await import("../utils/identity.js");
    await saveToVault(vault);
    console.log(`Secret '${args.key}' removed.`);
  } else {
    console.log(`Secret '${args.key}' not found.`);
  }
}

// ---------------------------------------------------------------------------
// List (manifest → vault fallback)
// ---------------------------------------------------------------------------

async function handleList(args: SecretsArgs): Promise<void> {
  const manifest = readManifest();

  if (!manifest) {
    // Fall back to vault
    const vault = await loadFromVault();
    if (!vault) {
      console.error("No vault found. Run `tps identity init` first.");
      process.exit(1);
    }
    console.error("no manifest found; run `tps secrets adopt` to scan existing secrets.");
    const keys = Object.keys(vault.secrets);
    if (args.json) {
      console.log(JSON.stringify(keys, null, 2));
    } else {
      if (keys.length === 0) {
        console.log("No secrets stored.");
      } else {
        console.log("Stored secrets:");
        for (const key of keys) {
          console.log(`  ${key}`);
        }
      }
    }
    return;
  }

  let entries = manifest.credentials;

  // Filter by owner
  if (args.owner) {
    const filtered: Record<string, CredentialEntry> = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.owners.includes(args.owner)) {
        filtered[name] = entry;
      }
    }
    entries = filtered;
  }

  // Filter by scope (S2)
  if (args.scope) {
    entries = filterByScope(entries, args.scope);
  }

  // Filter by type (S2)
  if (args.type) {
    entries = filterByType(entries, args.type);
  }

  // Filter by expiry
  if (args.expiresWithin) {
    entries = filterExpiresWithin(manifest, args.expiresWithin);
  }

  // Filter stale-only (S2)
  if (args.staleOnly) {
    entries = filterStaleOnly(entries);
  }

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (Object.keys(entries).length === 0) {
    console.log("No matching credentials.");
    return;
  }

  // S2: Render as table with: name, type, scope, status, age
  const rows: string[][] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const status = isEntryStale(entry) ? "⚠ STALE" : "✓";
    const age = entryAge(entry) ?? "—";
    rows.push([name, entry.type, entry.scope ?? "—", status, age]);
  }

  // Table header
  const cols = ["Name", "Type", "Scope", "Status", "Age"];
  const widths = cols.map((_, i) =>
    Math.max(cols[i].length, ...rows.map(r => (r[i] ?? "").length))
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const header = cols.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = widths.map(w => "─".repeat(w)).join("  ");

  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// Show (manifest entry — NEVER prints value)
// ---------------------------------------------------------------------------

function handleShow(args: SecretsArgs): void {
  if (!args.key) {
    console.error("Usage: tps secrets show <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  if (!manifest) {
    console.error("No manifest found. Run `tps secrets adopt` to scan existing secrets.");
    process.exit(1);
  }

  const entry = manifest.credentials[args.key];
  if (!entry) {
    console.error(`Credential '${args.key}' not found in manifest.`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({ entry, verify: verifyEntry(entry) }, null, 2));
    return;
  }

  // S2: Bold name + kv lines + verify status indicator
  console.log(`\x1b[1m${args.key}\x1b[0m`);
  console.log(`  Path:        ${entry.path}`);
  console.log(`  Type:        ${entry.type}`);
  console.log(`  Owners:      ${entry.owners.join(", ") || "(none)"}`);
  console.log(`  Sensitivity: ${entry.sensitivity}`);
  if (entry.scope) console.log(`  Scope:       ${entry.scope}`);
  if (entry.issued) console.log(`  Issued:      ${entry.issued}`);
  if (entry.expires) console.log(`  Expires:     ${entry.expires}`);
  if (entry.lastRotated) console.log(`  LastRotated: ${entry.lastRotated}`);
  if (entry.lastUsed) console.log(`  LastUsed:    ${entry.lastUsed}`);
  if (entry.notes) console.log(`  Notes:       ${entry.notes}`);

  // Verify status
  const vResult = verifyEntry(entry);
  const stale = isEntryStale(entry);
  if (vResult.ok && !stale) {
    console.log(`  Status:      \x1b[32m✓ OK\x1b[0m`);
  } else if (stale && vResult.ok) {
    console.log(`  Status:      \x1b[33m⚠ STALE\x1b[0m (expired)`);
  } else {
    console.log(`  Status:      \x1b[31m✗ FAIL\x1b[0m`);
    for (const issue of vResult.issues) {
      console.log(`    ${issue.kind}: ${issue.detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Emit (print contents to stdout — resolves ~)
// ---------------------------------------------------------------------------

function handleEmit(args: SecretsArgs): void {
  if (!args.key) {
    console.error("Usage: tps secrets emit <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  if (!manifest) {
    console.error("No manifest found. Run `tps secrets adopt` to scan existing secrets.");
    process.exit(1);
  }

  const entry = manifest.credentials[args.key];
  if (!entry) {
    console.error(`Credential '${args.key}' not found in manifest.`);
    process.exit(1);
  }

  const resolvedPath = expandPath(entry.path);
  if (!existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch {
    console.error(`Could not read: ${resolvedPath}`);
    process.exit(1);
  }

  // Log read for audit (S2 will write to audit log; S1 just stderr trace)
  console.error(`[audit] emit '${args.key}' from ${resolvedPath}`);

  process.stdout.write(content);
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function handleRegister(args: SecretsArgs): void {
  if (!args.key || !args.registerPath) {
    console.error(
      "Usage: tps secrets register <name> --path <p> --type <t> --owner <o> [--scope <s>] [--expires <iso8601>] [--sensitivity <level>]"
    );
    process.exit(1);
  }

  const manifest = readManifest() ?? { version: 1, credentials: {} };

  // Check for duplicates
  if (manifest.credentials[args.key]) {
    console.error(`Credential '${args.key}' is already registered. Use unregister first.`);
    process.exit(1);
  }

  // Reject reserved types
  const ctype = (args.registerType ?? "api-key") as CredentialType;
  if ((RESERVED_TYPES as readonly string[]).includes(ctype)) {
    console.error(`Type '${ctype}' is reserved for v2 encrypted-at-rest. Rejected.`);
    process.exit(1);
  }

  const owners = args.registerOwner
    ? args.registerOwner.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  const sensitivity = (args.registerSensitivity ?? sensitivityForType(ctype)) as CredentialEntry["sensitivity"];

  const entry: CredentialEntry = {
    path: args.registerPath,
    type: ctype,
    owners,
    sensitivity,
    scope: args.registerScope,
    expires: args.registerExpires,
  };

  manifest.credentials[args.key] = entry;
  writeManifest(manifest);
  console.log(`Registered '${args.key}' (${ctype}).`);
}

// ---------------------------------------------------------------------------
// Unregister
// ---------------------------------------------------------------------------

function handleUnregister(args: SecretsArgs): void {
  if (!args.key) {
    console.error("Usage: tps secrets unregister <name>");
    process.exit(1);
  }

  const manifest = readManifest();
  if (!manifest || !manifest.credentials[args.key]) {
    console.error(`Credential '${args.key}' not found in manifest.`);
    process.exit(1);
  }

  delete manifest.credentials[args.key];
  writeManifest(manifest);
  console.log(`Unregistered '${args.key}' (file not deleted).`);
}

// ---------------------------------------------------------------------------
// Adopt (scan + propose / apply)
// ---------------------------------------------------------------------------

function handleAdopt(args: SecretsArgs): void {
  const isDryRun = !args.adoptApply;

  const dirs = {
    secretsDir: args.adoptSecretsDir ?? join(homedir(), ".tps", "secrets"),
    identityDir: args.adoptIdentityDir ?? join(homedir(), ".tps", "identity"),
    flairKeysDir: args.adoptFlairKeysDir ?? join(homedir(), ".flair", "keys"),
    openclawConfigPath: join(homedir(), ".openclaw", "openclaw.json"),
  };

  const result: AdoptResult = walkAdoptCandidates(dirs);

  if (isDryRun) {
    printAdoptDryRun(result, args);
    return;
  }

  // --apply: commit to manifest, skip already-registered entries
  const existing = readManifest() ?? { version: 1, credentials: {} };
  const existingPaths = new Set(
    Object.values(existing.credentials).map(e => expandPath(e.path))
  );

  let added = 0;
  let skipped = 0;

  for (const candidate of result.candidates) {
    const candidatePath = expandPath(candidate.entry.path);
    if (existingPaths.has(candidatePath)) {
      skipped++;
      continue;
    }
    // Skip vaulted-secret
    if (candidate.entry.type === "vaulted-secret") {
      skipped++;
      continue;
    }
    // For adopt --apply in non-interactive mode: skip entries with no owners
    if (candidate.entry.owners.length === 0 && args.adoptNonInteractive) {
      skipped++;
      continue;
    }
    existing.credentials[candidate.name] = candidate.entry;
    existingPaths.add(candidatePath);
    added++;
  }

  writeManifest(existing);
  console.log(`Adopt complete: ${added} added, ${skipped} skipped`);

  if (result.openclawTokens.length > 0) {
    console.log(`\n⚠️  Found ${result.openclawTokens.length} embedded token(s) in openclaw.json (not extracted):`);
    for (const t of result.openclawTokens) {
      console.log(`  - ${t.agent}: ${t.note}`);
    }
  }
}

function printAdoptDryRun(result: AdoptResult, args: SecretsArgs): void {
  if (result.candidates.length === 0 && result.openclawTokens.length === 0) {
    console.log("No candidates found. Nothing to adopt.");
    return;
  }

  console.log("=== Proposed manifest (dry-run) ===\n");

  for (const candidate of result.candidates) {
    const e = candidate.entry;
    const owners = e.owners.length > 0 ? e.owners.join(", ") : "(none — interactive prompt needed)";
    let line: string;
    if (e.type === "vaulted-secret") {
      line = `⚠️  FLAG: ${candidate.name} → ${e.path} — LEGACY vault, do not migrate`;
    } else {
      line = `+ ${candidate.name} → ${e.path} (${e.type}, ${e.sensitivity}, owners: ${owners})`;
    }
    console.log(`  ${line}`);
  }

  if (result.openclawTokens.length > 0) {
    console.log("\n=== Embedded tokens in openclaw.json ===\n");
    for (const t of result.openclawTokens) {
      console.log(`  ⚠️  ${t.agent} — ${t.note}`);
    }
  }

  const noOwnerCount = result.candidates.filter(c => c.entry.owners.length === 0).length;
  console.log(`\n${result.candidates.length} candidate(s) proposed.${noOwnerCount > 0 ? ` ${noOwnerCount} need owner assignment.` : ""}`);
  console.log("Run with --apply to commit.\n");
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

function handleVerify(args: SecretsArgs): void {
  const manifest = readManifest();
  if (!manifest) {
    console.error("No manifest found. Run `tps secrets adopt` to scan existing secrets.");
    process.exit(1);
  }

  // Start with all entries
  let filteredManifest: CredentialsManifest = {
    version: 1,
    credentials: { ...manifest.credentials },
  };

  // Apply scope filter
  if (args.scope) {
    filteredManifest.credentials = filterByScope(filteredManifest.credentials, args.scope);
  }

  // Apply type filter
  if (args.type) {
    filteredManifest.credentials = filterByType(filteredManifest.credentials, args.type);
  }

  if (Object.keys(filteredManifest.credentials).length === 0) {
    console.log("No entries to verify (check filters).");
    process.exit(0);
  }

  // --fix: auto-correct permissions
  if (args.verifyFix) {
    const fixed = verifyFixAll(manifest);
    if (fixed.length === 0) {
      console.log("All permissions correct — nothing to fix.");
    } else {
      console.log(`Fixed ${fixed.length} file(s):`);
      for (const f of fixed) console.log(`  ${f}`);
    }
    return;
  }

  // S2: Use verifySummary for categorized reporting
  const summary = verifySummary(filteredManifest);
  let hasDrift = false;

  if (args.json) {
    const output: Record<string, any> = {
      ok: summary.ok,
      stale: summary.stale,
      missing: summary.missing,
      drift: summary.drift,
      entries: summary.entries.map(e => ({
        name: e.name,
        category: e.category,
        issues: e.issues,
        path: e.entry.path,
        type: e.entry.type,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    if (args.failOnDrift && summary.drift > 0) process.exit(1);
    return;
  }

  // Render table
  const rows: string[][] = [];
  const statusIcons: Record<string, string> = {
    ok: "✓",
    stale: "⚠",
    missing: "✗",
    drift: "✗",
  };

  for (const e of summary.entries) {
    if (e.category === "drift") hasDrift = true;
    rows.push([
      e.name,
      e.category.toUpperCase(),
      statusIcons[e.category] ?? "?",
      e.issues.length > 0 ? e.issues.map(i => `${i.kind}: ${i.detail}`).join("; ") : "—",
    ]);
  }

  const cols = ["Name", "Category", "Status", "Details"];
  const widths = cols.map((_, i) =>
    Math.max(cols[i].length, ...rows.map(r => (r[i] ?? "").length))
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const header = cols.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = widths.map(w => "─".repeat(w)).join("  ");

  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }

  // Summary line
  console.log(`\nOK: ${summary.ok}  STALE: ${summary.stale}  MISSING: ${summary.missing}  DRIFT: ${summary.drift}`);

  if (args.failOnDrift && hasDrift) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// S2: Scan (find orphaned credential candidates not in manifest)
// ---------------------------------------------------------------------------

function handleScan(args: SecretsArgs): void {
  const manifest = readManifest();
  if (!manifest) {
    console.error("No manifest found. Run `tps secrets adopt` to scan existing secrets.");
    process.exit(1);
  }

  const root = args.scanRoot ?? join(homedir(), ".tps");
  const dirs = {
    secretsDir: join(root, "secrets"),
    identityDir: join(root, "identity"),
    flairKeysDir: join(homedir(), ".flair", "keys"),
    openclawConfigPath: join(homedir(), ".openclaw", "openclaw.json"),
  };

  const orphans = scanOrphans(dirs, manifest);

  if (args.json) {
    const output = {
      candidates: orphans.map(c => ({
        name: c.name,
        path: c.entry.path,
        type: c.entry.type,
        sensitivity: c.entry.sensitivity,
        owners: c.entry.owners,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (orphans.length === 0) {
    console.log("No orphaned credential candidates found.");
    return;
  }

  console.log(`Found ${orphans.length} candidate(s) not in manifest:\n`);
  for (const candidate of orphans) {
    const e = candidate.entry;
    const owners = e.owners.length > 0 ? e.owners.join(", ") : "(none)";
    console.log(`  ${candidate.name}`);
    console.log(`    path: ${e.path}`);
    console.log(`    type: ${e.type}  sensitivity: ${e.sensitivity}`);
    console.log(`    owners: ${owners}`);
    console.log(`    → tps secrets adopt ${candidate.name}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// S2: Adopt a single candidate by path or name
// ---------------------------------------------------------------------------

function handleAdoptSingle(args: SecretsArgs): void {
  const candidatePath = args.key;
  if (!candidatePath) {
    console.error("Usage: tps secrets adopt <path-or-name>");
    process.exit(1);
  }

  // Resolve relative paths to the ~/.tps/secrets/ directory
  let resolvedPath = expandPath(candidatePath);
  if (!resolvedPath.startsWith("/") && !resolvedPath.startsWith(homedir())) {
    // Treat as name; look in ~/.tps/secrets/<name>
    resolvedPath = join(homedir(), ".tps", "secrets", candidatePath);
  }

  // Validate path exists
  if (!existsSync(resolvedPath)) {
    console.error(`Error: path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  // Validate it's a regular file and readable
  let content: string;
  try {
    const st = statSync(resolvedPath);
    if (!st.isFile()) {
      console.error(`Error: not a regular file: ${resolvedPath}`);
      process.exit(1);
    }
    content = readFileSync(resolvedPath, "utf-8");
  } catch {
    console.error(`Error: cannot read file: ${resolvedPath}`);
    process.exit(1);
  }

  // Infer metadata
  const type = inferTypeFromPath(resolvedPath, content);
  const credType: CredentialType = type === "unknown" ? "api-key" : type as CredentialType;
  const name = basename(resolvedPath);
  const owner = inferOwnerFromName(name);
  const sensitivity = sensitivityForType(credType);

  // Load manifest
  const manifest = readManifest() ?? { version: 1, credentials: {} };

  // Check for duplicate
  const existingPaths = new Set(
    Object.values(manifest.credentials).map(e => expandPath(e.path))
  );
  if (existingPaths.has(resolvedPath)) {
    console.error(`Error: path is already registered in manifest: ${resolvedPath}`);
    process.exit(1);
  }

  // Build entry
  const entry: CredentialEntry = {
    path: resolvedPath,
    type: credType,
    owners: owner ? [owner] : [],
    sensitivity,
  };

  manifest.credentials[name] = entry;

  // Ensure dir mode 0700 before writing
  mkdirSync(dirname(manifestPath()), { recursive: true, mode: 0o700 });
  writeManifest(manifest);

  if (args.json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(`Adopted '${name}' (${credType}, ${sensitivity}).`);
  }
}
