/**
 * sender-id.ts — the CLI's own mail sender identity, resolved once.
 *
 * This is the id an outbound message is signed as when its producer has no
 * agent-specific sender: roster invites
 * (no `TPS_AGENT_ID`), and the system-origin producers (bootstrap, hire
 * onboarding). The rules, in order: an explicit override, `TPS_AGENT_ID`,
 * `~/.tps/identity/host.json`'s `hostId`, then the vault host identity. The
 * CALLER validates the shape (an id that `sanitizeIdentifier` would change is
 * refused) — this function resolves, it does not judge.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadHostIdentityId } from "./identity.js";

export async function resolveCliSenderId(override?: string): Promise<string> {
  if (override) return override;
  if (process.env.TPS_AGENT_ID) return process.env.TPS_AGENT_ID;

  // Check host.json on disk before touching the vault (vault decrypt is expensive).
  const hostJsonPath = join(process.env.HOME || homedir(), ".tps", "identity", "host.json");
  if (existsSync(hostJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hostJsonPath, "utf-8"));
      if (parsed?.hostId) return String(parsed.hostId);
    } catch {
      /* fall through to the vault */
    }
  }

  return (await loadHostIdentityId()) || "unknown";
}
