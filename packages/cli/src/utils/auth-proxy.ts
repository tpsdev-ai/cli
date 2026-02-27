import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { refreshAnthropicToken, type StoredCredentials } from "../commands/auth.js";

const AUTH_DIR = join(process.env.HOME || homedir(), ".tps", "auth");

interface AuthHeaders {
  [key: string]: string;
}

function credPath(provider: string): string {
  return join(AUTH_DIR, `${provider}.json`);
}

function load(provider: string): StoredCredentials | null {
  const p = credPath(provider);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as StoredCredentials;
}

function save(provider: string, creds: StoredCredentials): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(credPath(provider), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function getAuthHeaders(provider: string): Promise<AuthHeaders | null> {
  const creds = load(provider);
  if (!creds) return null;

  if (provider !== "anthropic") return null;

  let current = creds;
  if (Date.now() > current.expiresAt - 5 * 60_000) {
    current = await refreshAnthropicToken(current);
    save(provider, current);
  }

  return {
    "x-api-key": current.accessToken,
    "User-Agent": "claude-code/1.0",
  };
}
