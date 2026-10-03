import { homedir } from "node:os";
import { join } from "node:path";

export const runtimeProviders = {
  "claude-code": "anthropic",
  codex: "openai",
  gemini: "google",
} as const;

export type CredentialRuntime = keyof typeof runtimeProviders;

export function providerAuthPath(provider: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".tps", "auth", `${provider}.json`);
}

export function runtimeCredentialFiles(
  runtime: CredentialRuntime,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const files = {
    "claude-code": [
      join(home, ".claude", ".credentials.json"),
      join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json"),
    ],
    codex: [
      join(env.CODEX_HOME || join(home, ".codex"), "auth.json"),
      join(home, ".config", "codex", "auth.json"),
    ],
    gemini: [join(home, ".gemini", "oauth_creds.json"), join(xdg, "gemini", "oauth_creds.json")],
  };
  return [...new Set(files[runtime])];
}
