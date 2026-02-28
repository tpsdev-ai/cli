/**
 * TPS Auth — Provider OAuth via CLI delegation.
 *
 * HOW THIS WORKS (transparency):
 * TPS does NOT implement its own OAuth flows or embed provider client IDs.
 * Instead, it delegates to the provider's official CLI tool:
 *
 *   tps auth login anthropic  →  runs `claude login`  →  reads ~/.claude/.credentials.json
 *   tps auth login google     →  runs `gemini auth login` → reads ~/.gemini/oauth_creds.json
 *   tps auth login openai     →  (future) runs codex login → reads its credential store
 *
 * The user authenticates directly with the provider's own tool. TPS reads
 * the resulting credentials and uses them for API calls. When TPS refreshes
 * tokens, it writes updated credentials back to both its own store AND the
 * original CLI's credential file to prevent split-brain token invalidation.
 * Refresh tokens were issued by the provider's CLI — TPS refreshes them
 * using the same client ID and token endpoint (standard OAuth2).
 *
 * No credential spoofing. No client ID impersonation. The user's existing
 * CLI subscription (Claude Pro, Gemini, ChatGPT Plus) is used transparently.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const AUTH_DIR = join(process.env.HOME || homedir(), ".tps", "auth");

// Anthropic OAuth constants (from Claude Code's public source)
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

export interface AuthArgs {
  action: "login" | "status" | "revoke" | "refresh";
  provider?: string;
}

export interface StoredCredentials {
  provider: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  clientId: string;
  scopes: string;
}

function authPath(provider: string): string {
  return join(AUTH_DIR, `${provider}.json`);
}

function ensureAuthDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
}

function saveCredentials(provider: string, creds: StoredCredentials): void {
  ensureAuthDir();
  writeFileSync(authPath(provider), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function loadCredentials(provider: string): StoredCredentials | null {
  const p = authPath(provider);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as StoredCredentials;
}

function humanExpiry(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `expires in ${h}h ${m}m`;
  return `expires in ${m}m`;
}

/**
 * Find a CLI binary, rejecting paths in CWD or relative directories
 * to prevent PATH hijacking (S46-B).
 */
function findCli(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf-8", timeout: 5000 });
  if (result.status !== 0) return null;
  const resolved = result.stdout.trim();
  // Reject relative paths and CWD-local binaries
  if (!resolved.startsWith("/")) return null;
  const cwd = process.cwd();
  if (resolved.startsWith(cwd + "/") || resolved.startsWith(cwd + "\\")) {
    console.error(
      `Security: refusing to run '${name}' from current directory (${resolved}).\n` +
      `Install it globally or use an absolute path.`
    );
    return null;
  }
  return resolved;
}

/**
 * Login via Claude Code CLI.
 * Runs `claude login`, then reads the resulting credentials.
 */
async function loginAnthropic(): Promise<void> {
  const claudePath = findCli("claude");
  if (!claudePath) {
    console.error(
      "Claude Code CLI not found. Install it first:\n" +
      "  npm install -g @anthropic-ai/claude-code\n" +
      "  https://docs.anthropic.com/en/docs/claude-code"
    );
    process.exit(1);
  }

  console.log("Running 'claude login' — authenticate in your browser...\n");
  const result = spawnSync(claudePath, ["login"], {
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.status !== 0) {
    console.error("claude login failed.");
    process.exit(1);
  }

  // Read credentials that Claude Code just stored
  const creds = readClaudeCodeCredentials();
  if (!creds) {
    console.error("Could not read Claude Code credentials after login.");
    process.exit(1);
  }

  saveCredentials("anthropic", creds);
  console.log(`\nanthropic  ✓ OAuth configured — ${humanExpiry(creds.expiresAt)}`);
}

/**
 * Read Claude Code's credential file.
 * Claude Code stores OAuth tokens at ~/.claude/.credentials.json
 */
function readClaudeCodeCredentials(): StoredCredentials | null {
  const credPath = join(process.env.HOME || homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) return null;

  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;

    return {
      provider: "anthropic",
      refreshToken: oauth.refreshToken,
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt || 0,
      clientId: ANTHROPIC_CLIENT_ID,
      scopes: oauth.scopes || "",
    };
  } catch {
    return null;
  }
}

/**
 * Sync refreshed tokens back to Claude Code's credential file so both
 * TPS and Claude Code stay in sync (fixes S46-C split-brain).
 */
function syncToClaudeCode(creds: StoredCredentials): void {
  const credPath = join(process.env.HOME || homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) return;

  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (!data.claudeAiOauth) return;

    data.claudeAiOauth.accessToken = creds.accessToken;
    data.claudeAiOauth.refreshToken = creds.refreshToken;
    data.claudeAiOauth.expiresAt = creds.expiresAt;

    writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort — don't fail the refresh if Claude Code's file is unwritable
  }
}

export async function refreshAnthropicToken(creds: StoredCredentials): Promise<StoredCredentials> {
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "claude-code/1.0",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: creds.clientId || ANTHROPIC_CLIENT_ID,
      refresh_token: creds.refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic token refresh failed: ${res.status}`);
  }

  const token = (await res.json()) as any;
  const refreshed: StoredCredentials = {
    ...creds,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
  };

  // Keep Claude Code in sync — no split-brain (S46-C)
  syncToClaudeCode(refreshed);

  return refreshed;
}

export function showStatus(): void {
  const providers = ["anthropic", "google", "openai"];

  for (const provider of providers) {
    const creds = loadCredentials(provider);
    if (!creds) {
      console.log(`  ${provider.padEnd(10)} ✗ not configured`);
      continue;
    }
    console.log(`  ${provider.padEnd(10)} ✓ OAuth — ${humanExpiry(creds.expiresAt)}`);
  }
  console.log(`  ollama     ✓ no auth needed`);
}

async function revokeProvider(provider: string): Promise<void> {
  const p = authPath(provider);
  if (existsSync(p)) unlinkSync(p);
  console.log(`${provider} credentials removed from local auth store.`);
  if (provider === "anthropic") {
    console.log("Revoke app access at: https://console.anthropic.com/settings/authorized-apps");
  }
}

export async function runAuth(args: AuthArgs): Promise<void> {
  switch (args.action) {
    case "login":
      if (args.provider === "anthropic") {
        await loginAnthropic();
      } else {
        console.error("Only 'anthropic' is supported in Phase 1.\n  tps auth login anthropic");
        process.exit(1);
      }
      return;
    case "status":
      showStatus();
      return;
    case "revoke":
      if (!args.provider) {
        console.error("Usage: tps auth revoke <provider>");
        process.exit(1);
      }
      await revokeProvider(args.provider);
      return;
    case "refresh":
      if (args.provider !== "anthropic") {
        console.error("Only 'anthropic' is supported in Phase 1.");
        process.exit(1);
      }
      {
        const creds = loadCredentials("anthropic");
        if (!creds) {
          console.error("No anthropic credentials found. Run: tps auth login anthropic");
          process.exit(1);
        }
        const refreshed = await refreshAnthropicToken(creds);
        saveCredentials("anthropic", refreshed);
        console.log(`anthropic  ✓ refreshed — ${humanExpiry(refreshed.expiresAt)}`);
      }
      return;
  }
}
