/**
 * credentials-manifest.ts — Cred Substrate S1: Inventory & Manifest Foundation
 * (ops-568p child)
 *
 * Pure module for reading/writing the credentials manifest, path expansion,
 * type inference, owner inference, and verification.
 *
 * No global state. No I/O on construction.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialType =
  | "github-pat-classic"
  | "github-pat-fine-grained"
  | "api-key"
  | "oauth-refresh"
  | "harper-admin-password"
  | "ed25519-seed"
  | "x25519-key"
  | "discord-bot-token"
  | "discord-webhook"
  | "vaulted-secret";

export type Sensitivity = "high" | "medium" | "low";

export interface CredentialEntry {
  path: string; // ~-prefixed allowed; resolver expands
  type: CredentialType;
  owners: string[];
  sensitivity: Sensitivity;
  scope?: string;
  issued?: string; // ISO 8601
  expires?: string; // ISO 8601
  lastRotated?: string;
  lastUsed?: string;
  notes?: string;
}

export interface CredentialsManifest {
  version: 1;
  credentials: Record<string, CredentialEntry>;
}

export const RESERVED_TYPES = ["vaulted-secret"] as const;

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
}

export interface VerifyIssue {
  kind: "missing-file" | "bad-mode" | "bad-format";
  name: string;
  path: string;
  detail: string;
}

export interface AdoptCandidate {
  name: string;
  entry: CredentialEntry;
}

export interface AdoptResult {
  candidates: AdoptCandidate[];
  openclawTokens: OpenClawTokenProposal[];
}

export interface OpenClawTokenProposal {
  agent: string;
  suggestedPath: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_AGENTS = [
  "anvil", "ember", "flint", "kern", "sherlock",
  "pulse", "quill", "reed", "nathan",
];

const TYPE_SENSITIVITY: Record<CredentialType, Sensitivity> = {
  "ed25519-seed": "high",
  "oauth-refresh": "high",
  "harper-admin-password": "high",
  "github-pat-classic": "medium",
  "github-pat-fine-grained": "medium",
  "api-key": "medium",
  "discord-bot-token": "medium",
  "discord-webhook": "medium",
  "x25519-key": "medium",
  "vaulted-secret": "high",
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the manifest file: ~/.tps/credentials/index.json */
export function manifestPath(): string {
  return join(homedir(), ".tps", "credentials", "index.json");
}

/**
 * Expand a path that may start with `~`.
 *   expandPath("~/foo") → `${homedir()}/foo`
 *   expandPath("/absolute/foo") → "/absolute/foo"
 */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/** Read the manifest. Returns null if the file doesn't exist or is invalid. */
export function readManifest(): CredentialsManifest | null {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf-8");
  try {
    const obj = JSON.parse(raw) as CredentialsManifest;
    if (obj.version !== 1) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Write the manifest to disk (overwrites; mode 0644). Creates parent dir if needed. */
export function writeManifest(m: CredentialsManifest): void {
  const p = manifestPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2), { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Type & owner inference
// ---------------------------------------------------------------------------

/** Guess the credential type from a path + optional content peek. */
export function inferTypeFromPath(
  p: string,
  content?: string | null
): CredentialType | "unknown" {
  const base = basename(p).toLowerCase();

  // GitHub PAT
  if (base.includes("github-pat") || base.includes("github_pat")) {
    if (base.includes("fine-grain") || base.includes("fine_grain")) {
      return "github-pat-fine-grained";
    }
    // Content-based disambiguation
    if (content) {
      const t = content.trim();
      if (t.startsWith("github_pat_")) return "github-pat-fine-grained";
      if (t.startsWith("ghp_")) return "github-pat-classic";
    }
    return "github-pat-classic";
  }

  // Ollama / oMLX API keys
  if (
    base.includes("ollama") ||
    base.startsWith("omlx") ||
    base.includes("omlx-api-key") ||
    base.includes("anthropic-api-key")
  ) {
    return "api-key";
  }

  // Harper admin password
  if (
    base.includes("admin-pass") ||
    (base.startsWith("flair") && base.includes("admin"))
  ) {
    return "harper-admin-password";
  }

  // Discord bot token
  if (base.includes("discord") && (base.includes("token") || base.includes("bot"))) {
    return "discord-bot-token";
  }

  // Discord webhook URL
  if (base.includes("webhook")) {
    return "discord-webhook";
  }

  // Default
  return "api-key";
}

/** Try to infer which agent owns a credential from its filename prefix. */
export function inferOwnerFromName(
  name: string,
  knownAgents: string[] = KNOWN_AGENTS
): string | null {
  const base = basename(name).toLowerCase();
  for (const agent of knownAgents) {
    if (base.startsWith(`${agent}-`)) return agent;
  }
  return null;
}

/** Get the prescribed sensitivity level for a credential type (Sherlock revision). */
export function sensitivityForType(t: CredentialType): Sensitivity {
  return TYPE_SENSITIVITY[t] ?? "medium";
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Verify a single credential entry against disk. */
export function verifyEntry(entry: CredentialEntry): VerifyResult {
  const issues: VerifyIssue[] = [];
  const resolvedPath = expandPath(entry.path);

  // File existence
  if (!existsSync(resolvedPath)) {
    issues.push({
      kind: "missing-file",
      name: resolvedPath,
      path: resolvedPath,
      detail: `file does not exist: ${resolvedPath}`,
    });
    return { ok: false, issues };
  }

  // Mode check
  const actualMode = statSync(resolvedPath).mode & 0o777;
  if (actualMode !== 0o600) {
    issues.push({
      kind: "bad-mode",
      name: resolvedPath,
      path: resolvedPath,
      detail: `expected 0600 but got 0${actualMode.toString(8)}`,
    });
  }

  // Format check
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8").trim();
  } catch {
    issues.push({
      kind: "bad-format",
      name: resolvedPath,
      path: resolvedPath,
      detail: "could not read file as utf-8",
    });
    return { ok: false, issues };
  }

  const fmtIssue = checkFormatInternal(entry.type, content);
  if (fmtIssue) {
    issues.push({
      kind: "bad-format",
      name: resolvedPath,
      path: resolvedPath,
      detail: fmtIssue,
    });
  }

  return { ok: issues.length === 0, issues };
}

/** Auto-fix permissions for a manifest entry (0600). */
export function verifyFixPermissions(entry: CredentialEntry): string[] {
  const fixed: string[] = [];
  const resolvedPath = expandPath(entry.path);
  if (!existsSync(resolvedPath)) return fixed;

  const actualMode = statSync(resolvedPath).mode & 0o777;
  if (actualMode !== 0o600) {
    chmodSync(resolvedPath, 0o600);
    fixed.push(`chmod 0600 → ${entry.path}`);
  }
  return fixed;
}

/** Run full verify on all manifest entries. */
export function verifyAll(
  manifest: CredentialsManifest
): Record<string, VerifyResult> {
  const results: Record<string, VerifyResult> = {};
  for (const [name, entry] of Object.entries(manifest.credentials)) {
    results[name] = verifyEntry(entry);
  }
  return results;
}

/** Run verify --fix on all manifest entries. */
export function verifyFixAll(manifest: CredentialsManifest): string[] {
  const allFixed: string[] = [];
  for (const [, entry] of Object.entries(manifest.credentials)) {
    allFixed.push(...verifyFixPermissions(entry));
  }
  return allFixed;
}

// ---------------------------------------------------------------------------
// Format checks (internal)
// ---------------------------------------------------------------------------

function checkFormatInternal(
  type: CredentialType,
  content: string
): string | null {
  switch (type) {
    case "github-pat-classic":
      if (!content.startsWith("ghp_"))
        return "expected content to start with ghp_";
      return null;

    case "github-pat-fine-grained":
      if (!content.startsWith("github_pat_"))
        return "expected content to start with github_pat_";
      return null;

    case "api-key":
      if (content.length === 0) return "content is empty";
      if (/\s/.test(content))
        return "contains whitespace characters (api-keys should be a single token)";
      return null;

    case "oauth-refresh":
      try {
        JSON.parse(content);
      } catch {
        return "expected valid JSON for oauth-refresh token";
      }
      return null;

    case "harper-admin-password":
      if (content.length === 0) return "content is empty after trim";
      return null;

    case "ed25519-seed":
      try {
        const buf = Buffer.from(content, "base64");
        if (buf.length !== 32)
          return `expected 32 bytes, got ${buf.length} when base64-decoded`;
      } catch {
        return "not valid base64";
      }
      return null;

    case "x25519-key":
      try {
        const buf = Buffer.from(content, "base64");
        if (buf.length !== 32)
          return `expected 32 bytes, got ${buf.length} when base64-decoded`;
      } catch {
        return "not valid base64";
      }
      return null;

    case "discord-bot-token":
      if (!/^[A-Za-z0-9._-]{50,}$/.test(content))
        return "expected discord bot token to match [A-Za-z0-9._-]{50,}";
      return null;

    case "discord-webhook":
      if (!content.startsWith("https://discord.com/api/webhooks/"))
        return "expected discord webhook URL to start with https://discord.com/api/webhooks/";
      return null;

    case "vaulted-secret":
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Adopt walker
// ---------------------------------------------------------------------------

export interface AdoptDirs {
  secretsDir: string;
  identityDir: string;
  flairKeysDir: string;
  openclawConfigPath: string;
}

/** Public-file extensions that should never appear in a credentials manifest. */
const PUBLIC_EXTENSIONS = new Set([".pub", ".public", ".crt", ".cert"]);

/** Walk the filesystem and produce adoption candidates (non-interactive core). */
export function walkAdoptCandidates(
  dirs: AdoptDirs
): AdoptResult {
  const candidates: AdoptCandidate[] = [];
  const openclawTokens: OpenClawTokenProposal[] = [];

  // 1. ~/.tps/secrets/* (skip vault.json, skip public-key files)
  try {
    const secretsFiles = readdirSync(dirs.secretsDir);
    for (const file of secretsFiles) {
      if (file === "vault.json") continue;

      // Skip public-key / certificate files
      const lowerFile = file.toLowerCase();
      if (PUBLIC_EXTENSIONS.has(lowerFile.slice(lowerFile.lastIndexOf(".")))) continue;

      const absPath = join(dirs.secretsDir, file);
      let content: string | null = null;
      try {
        content = readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }

      const type = inferTypeFromPath(absPath, content);
      const owner = inferOwnerFromName(file);
      const sensitivity = type !== "unknown"
        ? sensitivityForType(type as CredentialType)
        : "medium";

      const entry: CredentialEntry = {
        path: absPath,
        type: type === "unknown" ? "api-key" : type as CredentialType,
        owners: owner ? [owner] : [],
        sensitivity,
      };

      candidates.push({ name: file, entry });
    }
  } catch {
    // secrets dir may not exist
  }

  // 2. ~/.tps/identity/*.key (but NOT *.x25519.key, NOT *.meta.json) → ed25519-seed
  try {
    const keyFiles = readdirSync(dirs.identityDir).filter(
      f => f.endsWith(".key") && !f.endsWith(".x25519.key") && !f.endsWith(".meta.json")
    );
    for (const file of keyFiles) {
      const absPath = join(dirs.identityDir, file);
      const owner = inferOwnerFromName(file);
      candidates.push({
        name: file,
        entry: {
          path: absPath,
          type: "ed25519-seed",
          owners: owner ? [owner] : [],
          sensitivity: "high",
        },
      });
    }
  } catch {
    // identity dir may not exist
  }

  // 3. ~/.tps/identity/*.x25519.key → x25519-key
  try {
    const xKeyFiles = readdirSync(dirs.identityDir).filter(
      f => f.endsWith(".x25519.key")
    );
    for (const file of xKeyFiles) {
      const absPath = join(dirs.identityDir, file);
      const owner = inferOwnerFromName(file);
      candidates.push({
        name: file,
        entry: {
          path: absPath,
          type: "x25519-key",
          owners: owner ? [owner] : [],
          sensitivity: "medium",
        },
      });
    }
  } catch {
    // identity dir may not exist
  }

  // 4. ~/.tps/identity/vault.json — flag for human attention
  const vaultJsonPath = join(dirs.identityDir, "vault.json");
  if (existsSync(vaultJsonPath)) {
    candidates.push({
      name: "vault.json",
      entry: {
        path: vaultJsonPath,
        type: "vaulted-secret",
        owners: [],
        sensitivity: "high",
        notes: "LEGACY vault — do not migrate to manifest in S1.",
      },
    });
  }

  // 5. ~/.flair/keys/*.key (but NOT *.x25519.key, NOT *.meta.json) → ed25519-seed
  try {
    const flairKeyFiles = readdirSync(dirs.flairKeysDir).filter(
      f => f.endsWith(".key") && !f.endsWith(".x25519.key") && !f.endsWith(".meta.json")
    );
    for (const file of flairKeyFiles) {
      const absPath = join(dirs.flairKeysDir, file);
      const owner = inferOwnerFromName(file);
      candidates.push({
        name: `flair-${file}`,
        entry: {
          path: absPath,
          type: "ed25519-seed",
          owners: owner ? [owner] : [],
          sensitivity: "high",
        },
      });
    }
  } catch {
    // flair keys dir may not exist
  }

  // 6. ~/.flair/keys/*.x25519.key → x25519-key
  try {
    const flairXKeyFiles = readdirSync(dirs.flairKeysDir).filter(
      f => f.endsWith(".x25519.key")
    );
    for (const file of flairXKeyFiles) {
      const absPath = join(dirs.flairKeysDir, file);
      const owner = inferOwnerFromName(file);
      candidates.push({
        name: `flair-${file}`,
        entry: {
          path: absPath,
          type: "x25519-key",
          owners: owner ? [owner] : [],
          sensitivity: "medium",
        },
      });
    }
  } catch {
    // flair keys dir may not exist
  }

  // 7. ~/.openclaw/openclaw.json — scan for embedded tokens
  if (existsSync(dirs.openclawConfigPath)) {
    try {
      const ocRaw = readFileSync(dirs.openclawConfigPath, "utf-8");
      const oc = JSON.parse(ocRaw);
      scanConfigSection(oc, "agents", openclawTokens);
      scanConfigSection(oc, "providers", openclawTokens);
    } catch {
      // not valid JSON — skip
    }
  }

  return { candidates, openclawTokens };
}

function scanConfigSection(
  config: any,
  section: string,
  out: OpenClawTokenProposal[]
): void {
  const items = config[section];
  if (!items || typeof items !== "object") return;

  for (const [key, val] of Object.entries(items)) {
    if (val && typeof val === "object") {
      const token = (val as any).token;
      if (token && typeof token === "string") {
        const suggestedPath = `~/.tps/secrets/discord-bot-${key}`;
        out.push({
          agent: key,
          suggestedPath: expandPath(suggestedPath),
          note: `Found embedded token in ${section}.${key}.token — propose extraction to ${suggestedPath}. Update openclaw.json to read from process.env.TPS_DISCORD_TOKEN_FILE.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Expiry filtering
// ---------------------------------------------------------------------------

/** Parse a duration string like "7d", "30d", "24h", "1w" into milliseconds. */
export function parseDuration(dur: string): number | null {
  const match = dur.trim().match(/^(\d+)([dhmw])$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case "d": return val * 24 * 60 * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "m": return val * 60 * 1000;
    case "w": return val * 7 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Filter manifest entries by expiry.
 * Returns entries whose `expires` field is within `duration` from `now`.
 */
export function filterExpiresWithin(
  manifest: CredentialsManifest,
  duration: string,
  now: Date = new Date()
): Record<string, CredentialEntry> {
  const ms = parseDuration(duration);
  if (ms === null) return manifest.credentials;

  const threshold = now.getTime() + ms;
  const filtered: Record<string, CredentialEntry> = {};
  for (const [name, entry] of Object.entries(manifest.credentials)) {
    if (entry.expires) {
      const expiresMs = new Date(entry.expires).getTime();
      if (!isNaN(expiresMs) && expiresMs <= threshold) {
        filtered[name] = entry;
      }
    }
  }
  return filtered;
}
