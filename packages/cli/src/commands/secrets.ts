/**
 * secrets.ts — Cred Substrate S1 secrets command
 *
 * Extends the vault-based secrets commands with credential manifest operations:
 *   list (manifest-aware), show, emit, register, unregister, adopt, verify
 */

import { loadFromVault, TpsVault } from "../utils/identity.js";
import {
  readManifest,
  writeManifest,
  expandPath,
  CredentialsManifest,
  CredentialEntry,
  CredentialType,
  RESERVED_TYPES,
  sensitivityForType,
  VerifyResult,
  verifyAll,
  verifyFixAll,
  filterExpiresWithin,
  walkAdoptCandidates,
  AdoptResult,
  AdoptCandidate,
} from "../utils/credentials-manifest.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// CLI entry point types
// ---------------------------------------------------------------------------

export type SecretsAction =
  | "set" | "list" | "remove"       // vault (legacy)
  | "show" | "emit"                 // manifest read
  | "register" | "unregister"       // manifest write
  | "adopt"                         // scan + propose
  | "verify";                       // check manifest integrity

export interface SecretsArgs {
  action: SecretsAction;
  // vault
  key?: string;
  value?: string;
  // list filtering
  owner?: string;
  expiresWithin?: string;
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
  adoptKeysDir?: string;
  // verify
  verifyFix?: boolean;
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
    case "verify":
      handleVerify(args);
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

  // Filter by expiry
  if (args.expiresWithin) {
    entries = filterExpiresWithin(manifest, args.expiresWithin);
  }

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (Object.keys(entries).length === 0) {
    console.log("No matching credentials.");
    return;
  }

  for (const [name, entry] of Object.entries(entries)) {
    const owners = entry.owners.length > 0 ? `[${entry.owners.join(", ")}]` : "[none]";
    const expires = entry.expires ? ` expires: ${entry.expires}` : "";
    console.log(`  ${name}`);
    console.log(`    path: ${entry.path}  type: ${entry.type}  sensitivity: ${entry.sensitivity}${expires}`);
    console.log(`    owners: ${owners}`);
    console.log("");
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
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  console.log(`Name:        ${args.key}`);
  console.log(`Path:        ${entry.path}`);
  console.log(`Type:        ${entry.type}`);
  console.log(`Owners:      ${entry.owners.join(", ") || "(none)"}`);
  console.log(`Sensitivity: ${entry.sensitivity}`);
  if (entry.scope) console.log(`Scope:       ${entry.scope}`);
  if (entry.issued) console.log(`Issued:      ${entry.issued}`);
  if (entry.expires) console.log(`Expires:     ${entry.expires}`);
  if (entry.lastRotated) console.log(`LastRotated: ${entry.lastRotated}`);
  if (entry.lastUsed) console.log(`LastUsed:    ${entry.lastUsed}`);
  if (entry.notes) console.log(`Notes:       ${entry.notes}`);
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
    keysDir: args.adoptKeysDir ?? join(homedir(), ".tps", "keys"),
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

  const entries = Object.entries(manifest.credentials);
  if (entries.length === 0) {
    console.log("Manifest is empty.");
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

  const results = verifyAll(manifest);
  let allOk = true;

  for (const [name, result] of Object.entries(results)) {
    if (result.ok) {
      console.log(`✓ ${name}`);
    } else {
      allOk = false;
      console.log(`✗ ${name}`);
      for (const issue of result.issues) {
        console.log(`    ${issue.kind}: ${issue.detail}`);
      }
    }
  }

  console.log(`\n${allOk ? "All checks passed." : "Some checks failed."}`);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (!allOk) process.exit(1);
}
