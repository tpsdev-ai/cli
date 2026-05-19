/**
 * facts-cache.ts — Facts Substrate S1: Cache I/O
 * (ops-568p child)
 *
 * Pure module. Cache file: ~/.tps/facts/cache.json (mode 0600).
 * Atomic writes (temp + rename) to prevent corruption from concurrent access.
 */

import { existsSync, readFileSync } from "node:fs";
import { cachePath, atomicWrite, ensureFactsDir } from "./facts-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry {
  value: string | number | boolean | object;
  verifiedAt: string; // ISO 8601
  ttl_expires: string; // ISO 8601 or literal "manual"
}

export interface FactsCache {
  version: 1;
  values: Record<string, CacheEntry>;
}

export type CacheStatus =
  | "fresh"
  | "drift_detected"
  | "no_verify_flag"
  | "verify_failed_timeout"
  | "verify_failed_nonzero_exit"
  | "verify_failed_invalid_type"
  | "verify_failed_blocked_command"
  | "verify_failed_spawn_error"
  | "not_in_cache";

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

/**
 * Read the facts cache. Returns a default empty cache if the file
 * doesn't exist or is malformed.
 */
export function readCache(): FactsCache {
  const p = cachePath();
  const defaultCache: FactsCache = { version: 1, values: {} };

  if (!existsSync(p)) {
    return defaultCache;
  }

  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || parsed.version !== 1) {
      console.warn(`facts: cache at ${p} has unknown version, treating as empty`);
      return defaultCache;
    }

    return { version: 1, values: parsed.values ?? {} };
  } catch (err) {
    console.warn(`facts: failed to read cache at ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return defaultCache;
  }
}

/**
 * Write the facts cache atomically. Prevents corruption from concurrent access.
 * (Sherlock: temp+rename pattern same as manifest — §A, "Concurrent cache access")
 */
export function writeCache(cache: FactsCache): void {
  ensureFactsDir();
  const content = JSON.stringify(cache, null, 2) + "\n";
  atomicWrite(cachePath(), content, 0o600);
}

/**
 * Get a cached value for a fact. Returns null if not in cache.
 */
export function getCachedValue(
  cache: FactsCache,
  name: string
): CacheEntry | null {
  return cache.values[name] ?? null;
}

/**
 * Set a cached value for a fact and persist atomically.
 */
export function setCachedValue(
  name: string,
  value: string | number | boolean | object,
  ttl_expires: string
): void {
  const cache = readCache();
  cache.values[name] = {
    value,
    verifiedAt: new Date().toISOString(),
    ttl_expires,
  };
  writeCache(cache);
}

// ---------------------------------------------------------------------------
// TTL helpers
// ---------------------------------------------------------------------------

import type { FactTtl } from "./facts-manifest.js";

/**
 * Parse a TTL string to milliseconds.
 */
export function parseTtlMs(ttl: string): number | "manual" {
  switch (ttl) {
    case "manual": return "manual";
    case "30s": return 30 * 1000;
    case "1m": return 60 * 1000;
    case "5m": return 5 * 60 * 1000;
    case "1h": return 60 * 60 * 1000;
    case "1d": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
    default: return "manual";
  }
}

/**
 * Check if a cached entry's TTL has expired.
 * Returns true if the entry is stale (should re-verify).
 */
export function isCacheExpired(entry: CacheEntry): boolean {
  if (entry.ttl_expires === "manual") return false;
  const expires = new Date(entry.ttl_expires).getTime();
  return Date.now() > expires;
}

/**
 * Compute the TTL expiry ISO string from a TTL value.
 */
export function computeTtlExpiry(ttl: FactTtl): string {
  const ms = parseTtlMs(ttl);
  if (ms === "manual") return "manual";
  return new Date(Date.now() + ms).toISOString();
}
