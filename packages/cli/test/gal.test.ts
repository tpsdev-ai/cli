import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override TPS_ROOT to an isolated temp dir for each test
let testRoot: string;

function withTestRoot<T>(fn: () => T): T {
  const orig = process.env.TPS_ROOT;
  process.env.TPS_ROOT = testRoot;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.TPS_ROOT;
    else process.env.TPS_ROOT = orig;
  }
}

// Re-import gal functions using TPS_ROOT override
// We import inline so the module uses the current env
async function getGal() {
  // Clear bun module cache by using a fresh dynamic import each time
  return await import("../src/utils/gal.js");
}

describe("GAL utilities", () => {
  beforeEach(() => {
    testRoot = join(tmpdir(), `tps-gal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    process.env.TPS_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.TPS_ROOT;
    try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
  });

  it("returns empty list when no gal.json exists", async () => {
    const { galList } = await getGal();
    expect(galList()).toEqual([]);
  });

  it("galSet adds a new entry", async () => {
    const { galSet, galList, galLookup } = await getGal();
    const entry = galSet("flint", "tps-rockit");
    expect(entry.agentId).toBe("flint");
    expect(entry.branchId).toBe("tps-rockit");
    expect(entry.updatedAt).toBeString();

    const entries = galList();
    expect(entries).toHaveLength(1);
    expect(galLookup("flint")).toBe("tps-rockit");
  });

  it("galSet updates an existing entry", async () => {
    const { galSet, galList } = await getGal();
    galSet("flint", "tps-rockit");
    galSet("flint", "tps-rockit-2");

    const entries = galList();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.branchId).toBe("tps-rockit-2");
  });

  it("galLookup returns null for unknown agent", async () => {
    const { galLookup } = await getGal();
    expect(galLookup("unknown-agent")).toBeNull();
  });

  it("galRemove removes an existing entry", async () => {
    const { galSet, galRemove, galList } = await getGal();
    galSet("flint", "tps-rockit");
    galSet("kern", "tps-rockit");

    const removed = galRemove("flint");
    expect(removed).toBe(true);

    const entries = galList();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentId).toBe("kern");
  });

  it("galRemove returns false for unknown entry", async () => {
    const { galRemove } = await getGal();
    expect(galRemove("nobody")).toBe(false);
  });

  it("galSync seeds from branch-office dirs with remote.json", async () => {
    const { galSync, galList } = await getGal();
    // Set up fake branch-office dirs
    const branchDir = join(testRoot, "branch-office");
    mkdirSync(join(branchDir, "tps-rockit"), { recursive: true });
    writeFileSync(join(branchDir, "tps-rockit", "remote.json"), JSON.stringify({ host: "rockit" }));
    mkdirSync(join(branchDir, "tps-ember"), { recursive: true });
    writeFileSync(join(branchDir, "tps-ember", "remote.json"), JSON.stringify({ host: "ember" }));
    // Dir without remote.json should be ignored
    mkdirSync(join(branchDir, "no-remote"), { recursive: true });

    const result = galSync();
    expect(result.added).toContain("tps-rockit");
    expect(result.added).toContain("tps-ember");
    expect(result.skipped).toHaveLength(0);

    const entries = galList();
    expect(entries).toHaveLength(2);
  });

  it("galSync skips already-present entries", async () => {
    const { galSet, galSync } = await getGal();
    galSet("tps-rockit", "tps-rockit");

    const branchDir = join(testRoot, "branch-office");
    mkdirSync(join(branchDir, "tps-rockit"), { recursive: true });
    writeFileSync(join(branchDir, "tps-rockit", "remote.json"), JSON.stringify({}));

    const result = galSync();
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toContain("tps-rockit");
  });

  it("galSync returns empty result when branch-office dir missing", async () => {
    const { galSync } = await getGal();
    const result = galSync();
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("handles corrupted gal.json gracefully", async () => {
    const { galList, galSet } = await getGal();
    writeFileSync(join(testRoot, "gal.json"), "not valid json");
    expect(galList()).toEqual([]);
    // Can still write to a corrupted file
    galSet("flint", "tps-rockit");
    expect(galList()).toHaveLength(1);
  });
});
