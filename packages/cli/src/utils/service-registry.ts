/**
 * service-registry.ts — OPS-122 Branch Service Proxy
 *
 * Manages the host-side service registry at ~/.tps/branch-services.json.
 * Services registered here are advertised to branch offices via MSG_JOIN_COMPLETE
 * and proxied on demand via MSG_SERVICE_REQUEST / MSG_SERVICE_RESPONSE.
 *
 * Security (K&S):
 * - Service names validated: ^[a-zA-Z0-9._-]{1,64}$
 * - URLs must be http:// or https:// pointing to localhost/127.0.0.1
 * - Atomic writes (tmp + rename)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface ServiceEntry {
  url: string;
  description?: string;
  localPort?: number;      // suggested local port for branch-side proxy
  timeoutMs?: number;      // per-request timeout (default 30s)
}

export interface ServiceRegistry {
  [name: string]: ServiceEntry;
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** Validate a service name — same regex as agentId for consistency */
export function validateServiceName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid service name: "${name}". Must match ^[a-zA-Z0-9._-]{1,64}$`);
  }
}

/** Validate a service URL — must be localhost or 127.x.x.x (host-local only) */
export function validateServiceUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Service URL must be http:// or https://, got: "${url}"`);
  }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && !host.startsWith("127.")) {
    throw new Error(`Service URL must point to localhost or 127.x.x.x (host-local only), got: "${host}"`);
  }
}

function registryPath(): string {
  return join(process.env.TPS_ROOT ?? join(homedir(), ".tps"), "branch-services.json");
}

export function loadRegistry(): ServiceRegistry {
  const path = registryPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ServiceRegistry;
  } catch {
    return {};
  }
}

function saveRegistry(reg: ServiceRegistry): void {
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function registerService(name: string, url: string, opts: Partial<Omit<ServiceEntry, "url">> = {}): void {
  validateServiceName(name);
  validateServiceUrl(url);
  const reg = loadRegistry();
  reg[name] = { url: url.replace(/\/$/, ""), ...opts };
  saveRegistry(reg);
}

export function removeService(name: string): boolean {
  validateServiceName(name);
  const reg = loadRegistry();
  if (!(name in reg)) return false;
  delete reg[name];
  saveRegistry(reg);
  return true;
}

export function getService(name: string): ServiceEntry | null {
  validateServiceName(name);
  const reg = loadRegistry();
  return reg[name] ?? null;
}

export function listServices(): Array<{ name: string } & ServiceEntry> {
  const reg = loadRegistry();
  return Object.entries(reg).map(([name, entry]) => ({ name, ...entry }));
}

/** Default services registered on first run if registry is empty */
export const DEFAULT_SERVICES: Array<{ name: string; url: string; localPort: number; description: string }> = [
  { name: "flair", url: "http://127.0.0.1:9926", localPort: 9926, description: "Flair memory service" },
];

export function ensureDefaultServices(): void {
  const reg = loadRegistry();
  let changed = false;
  for (const svc of DEFAULT_SERVICES) {
    if (!reg[svc.name]) {
      reg[svc.name] = { url: svc.url, localPort: svc.localPort, description: svc.description };
      changed = true;
    }
  }
  if (changed) saveRegistry(reg);
}
