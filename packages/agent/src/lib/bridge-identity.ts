import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedTrustTier, type TrustLevel } from "../runtime/types.js";

export const BRIDGE_ADAPTERS = ["openclaw", "discord", "stdio"] as const;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function resolveBridgeAgentId(adapter: string, configured?: string): string {
  return configured ?? process.env.TPS_BRIDGE_AGENT_ID ?? `${adapter}-bridge`;
}

export function configureBridgeIdentity(mailRoot: string, adapter: string, configured?: string): string {
  const id = resolveBridgeAgentId(adapter, configured);
  if (!ID.test(id)) throw new Error("Invalid bridge principal id");
  const dir = join(mailRoot, ".bridge-principals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id }), { mode: 0o600 });
  return id;
}

export function bridgePrincipalIds(mailRoot: string, configured?: string): Set<string> {
  const ids = new Set<string>(BRIDGE_ADAPTERS.map((adapter) => `${adapter}-bridge`));
  for (const id of [configured, process.env.TPS_BRIDGE_AGENT_ID]) if (id) ids.add(id);
  const dir = join(mailRoot, ".bridge-principals");
  let files: string[];
  try { files = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ids;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (typeof record.id !== "string" || !ID.test(record.id)) throw new Error("Invalid bridge principal configuration");
    ids.add(record.id);
  }
  return ids;
}

export function verifiedMailTier(
  envelope: { from: string; trust?: unknown }, mailRoot: string, configured?: string,
): TrustLevel | undefined {
  if (bridgePrincipalIds(mailRoot, configured).has(envelope.from)) return "external";
  return envelope.trust === undefined ? undefined : signedTrustTier(envelope.trust);
}
