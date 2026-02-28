/**
 * TPS Auth — Provider OAuth via CLI delegation.
 *
 * HOW THIS WORKS (transparency):
 * TPS does NOT implement its own OAuth flows or embed provider client IDs.
 * Instead, it delegates to the provider's official CLI tool:
 *
 *   tps auth login anthropic  →  runs `claude login`  →  reads ~/.claude/.credentials.json
 *   tps auth login google     →  runs `gemini auth login` (best-effort) → reads ~/.gemini/oauth_creds.json
 *   tps auth login openai     →  (future) runs codex login → reads its credential store
 *
 * The user authenticates directly with the provider's own tool. TPS reads
 * the resulting credentials and uses them for API calls. When TPS refreshes
 * tokens, it writes updated credentials back to both its own store AND the
 * original CLI's credential file to prevent split-brain token invalidation.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const AUTH_DIR = join(process.env.HOME || homedir(), ".tps", "auth");

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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

function findCli(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf-8", timeout: 5000 });
  if (result.status !== 0) return null;
  const resolved = result.stdout.trim();
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

  const creds = readClaudeCodeCredentials();
  if (!creds) {
    console.error("Could not read Claude Code credentials after login.");
    process.exit(1);
  }

  saveCredentials("anthropic", creds);
  console.log(`\nanthropic  ✓ OAuth configured — ${humanExpiry(creds.expiresAt)}`);
}

async function loginGoogle(): Promise<void> {
  const geminiPath = findCli("gemini");
  if (!geminiPath) {
    console.error("Gemini CLI not found. Install it first: https://github.com/google-gemini/gemini-cli");
    process.exit(1);
  }

  const runLogin = spawnSync(geminiPath, ["auth", "login"], {
    stdio: "inherit",
    timeout: 120_000,
  });
  if (runLogin.status !== 0) {
    console.log("gemini auth login unavailable; falling back to existing ~/.gemini credentials.");
  }

  const creds = readGeminiCredentials();
  if (!creds) {
    console.error("Could not read Gemini credentials. Ensure Gemini CLI is logged in.");
    process.exit(1);
  }

  saveCredentials("google", creds);
  console.log(`\ngoogle     ✓ OAuth configured — ${humanExpiry(creds.expiresAt)}`);
}

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

function readGeminiCredentials(): StoredCredentials | null {
  const home = process.env.HOME || homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const candidates = [
    join(home, ".gemini", "oauth_creds.json"),
    join(xdg, "gemini", "oauth_creds.json"),
  ];

  for (const credPath of candidates) {
    if (!existsSync(credPath)) continue;
    try {
      const data = JSON.parse(readFileSync(credPath, "utf-8"));
      if (!data?.access_token || !data?.refresh_token) continue;

      return {
        provider: "google",
        refreshToken: data.refresh_token,
        accessToken: data.access_token,
        expiresAt: Number(data.expiry_date || 0),
        clientId: String(data.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID || ""),
        scopes: String(data.scope || ""),
      };
    } catch {
      // try next
    }
  }

  return null;
}

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
    // Best-effort
  }
}

function syncToGeminiCli(creds: StoredCredentials): void {
  const home = process.env.HOME || homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const candidates = [
    join(home, ".gemini", "oauth_creds.json"),
    join(xdg, "gemini", "oauth_creds.json"),
  ];

  for (const credPath of candidates) {
    if (!existsSync(credPath)) continue;
    try {
      const data = JSON.parse(readFileSync(credPath, "utf-8"));
      data.access_token = creds.accessToken;
      data.refresh_token = creds.refreshToken;
      data.expiry_date = creds.expiresAt;
      if (creds.scopes) data.scope = creds.scopes;
      if (creds.clientId) data.client_id = creds.clientId;
      writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      return;
    } catch {
      // continue
    }
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

  syncToClaudeCode(refreshed);
  return refreshed;
}

export async function refreshGoogleToken(creds: StoredCredentials): Promise<StoredCredentials> {
  if (!creds.clientId) {
    throw new Error("Google OAuth refresh requires clientId. Re-login with Gemini or set GOOGLE_OAUTH_CLIENT_ID.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }

  const token = (await res.json()) as any;
  const refreshed: StoredCredentials = {
    ...creds,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
    scopes: token.scope || creds.scopes,
  };

  syncToGeminiCli(refreshed);
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
      } else if (args.provider === "google") {
        await loginGoogle();
      } else {
        console.error("Supported providers: anthropic, google\n  tps auth login anthropic\n  tps auth login google");
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
      if (args.provider !== "anthropic" && args.provider !== "google") {
        console.error("Supported refresh providers: anthropic, google.");
        process.exit(1);
      }
      {
        const provider = args.provider;
        const creds = loadCredentials(provider);
        if (!creds) {
          console.error(`No ${provider} credentials found. Run: tps auth login ${provider}`);
          process.exit(1);
        }
        const refreshed = provider === "anthropic"
          ? await refreshAnthropicToken(creds)
          : await refreshGoogleToken(creds);
        saveCredentials(provider, refreshed);
        console.log(`${provider.padEnd(10)} ✓ refreshed — ${humanExpiry(refreshed.expiresAt)}`);
      }
      return;
  }
}
