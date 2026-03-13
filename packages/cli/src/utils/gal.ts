/**
 * gal.ts — Global Address List
 *
 * Maps agent names (e.g. "flint") to their physical branch IDs (e.g. "tps-rockit").
 * Stored at ~/.tps/gal.json. Simple JSON file, no external deps.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface GalEntry {
  agentId: string;     // logical name (e.g. "flint")
  branchId: string;    // physical branch ID (e.g. "tps-rockit")
  updatedAt: string;   // ISO timestamp
}

export interface GalFile {
  version: 1;
  entries: GalEntry[];
}

function tpsRoot(): string {
  return process.env.TPS_ROOT || join(process.env.HOME || homedir(), ".tps");
}

export function galPath(): string {
  return join(tpsRoot(), "gal.json");
}

function loadGal(): GalFile {
  const p = galPath();
  if (!existsSync(p)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (raw?.version === 1 && Array.isArray(raw.entries)) return raw as GalFile;
  } catch { /* fall through */ }
  return { version: 1, entries: [] };
}

function saveGal(gal: GalFile): void {
  mkdirSync(tpsRoot(), { recursive: true });
  writeFileSync(galPath(), JSON.stringify(gal, null, 2) + "\n", "utf-8");
}

/**
 * Look up the branch ID for a given agent name.
 * Returns null if not found.
 */
export function galLookup(agentId: string): string | null {
  const gal = loadGal();
  const entry = gal.entries.find(e => e.agentId === agentId);
  return entry?.branchId ?? null;
}

/**
 * List all GAL entries.
 */
export function galList(): GalEntry[] {
  return loadGal().entries;
}

/**
 * Add or update a GAL entry.
 */
export function galSet(agentId: string, branchId: string): GalEntry {
  const gal = loadGal();
  const idx = gal.entries.findIndex(e => e.agentId === agentId);
  const entry: GalEntry = { agentId, branchId, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    gal.entries[idx] = entry;
  } else {
    gal.entries.push(entry);
  }
  saveGal(gal);
  return entry;
}

/**
 * Remove a GAL entry by agent ID.
 * Returns true if removed, false if not found.
 */
export function galRemove(agentId: string): boolean {
  const gal = loadGal();
  const before = gal.entries.length;
  gal.entries = gal.entries.filter(e => e.agentId !== agentId);
  if (gal.entries.length === before) return false;
  saveGal(gal);
  return true;
}

/**
 * Seed the GAL from existing branch-office registrations.
 * Reads ~/.tps/branch-office/ dirs that have a remote.json and registers them.
 * Uses the directory name as both agentId and branchId (can be updated manually).
 * Does not overwrite existing entries.
 */
export function galSync(): { added: string[]; skipped: string[] } {
  const branchDir = join(tpsRoot(), "branch-office");
  if (!existsSync(branchDir)) return { added: [], skipped: [] };

  const added: string[] = [];
  const skipped: string[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(branchDir);
  } catch {
    return { added: [], skipped: [] };
  }

  for (const branchId of dirs) {
    const remoteJsonPath = join(branchDir, branchId, "remote.json");
    if (!existsSync(remoteJsonPath)) continue;
    if (galLookup(branchId) !== null) {
      skipped.push(branchId);
      continue;
    }
    galSet(branchId, branchId);
    added.push(branchId);
  }

  return { added, skipped };
}
