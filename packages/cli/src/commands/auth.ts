import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const AUTH_DIR = join(process.env.HOME || homedir(), ".tps", "auth");
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";

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
  mkdirSync(AUTH_DIR, { recursive: true });
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

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.unref();
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

function parseCodeAndState(inputCode: string): { code: string; state?: string } {
  if (inputCode.includes("#")) {
    const [code, state] = inputCode.split("#", 2);
    return { code: code.trim(), state: state?.trim() };
  }
  return { code: inputCode.trim() };
}

async function exchangeAnthropicCode(code: string, codeVerifier: string): Promise<StoredCredentials> {
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "claude-code/1.0",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth exchange failed: ${res.status} ${await res.text()}`);
  }

  const token = (await res.json()) as any;
  return {
    provider: "anthropic",
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
    clientId: ANTHROPIC_CLIENT_ID,
    scopes: ANTHROPIC_SCOPES,
  };
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
    throw new Error(`Anthropic token refresh failed: ${res.status} ${await res.text()}`);
  }

  const token = (await res.json()) as any;
  return {
    ...creds,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
  };
}

async function loginAnthropic(): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(ANTHROPIC_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", ANTHROPIC_REDIRECT_URI);
  authUrl.searchParams.set("scope", ANTHROPIC_SCOPES);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log(`Opening browser for Anthropic OAuth...`);
  console.log(authUrl.toString());
  try {
    openInBrowser(authUrl.toString());
  } catch {
    // no-op, URL already printed
  }

  const rl = createInterface({ input, output });
  const pasted = await rl.question("Paste callback code (code#state): ");
  rl.close();

  const parsed = parseCodeAndState(pasted);
  if (parsed.state && parsed.state !== state) {
    throw new Error("OAuth state mismatch");
  }

  const creds = await exchangeAnthropicCode(parsed.code, verifier);
  saveCredentials("anthropic", creds);
  console.log(`anthropic  ✓ OAuth configured — ${humanExpiry(creds.expiresAt)}`);
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
        console.error("Only 'anthropic' is supported in Phase 1");
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
        console.error("Only 'anthropic' is supported in Phase 1");
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
