/**
 * Credentials Manifest S2 tests
 *
 * Covers new S2 primitives:
 *   filterByScope, filterByType, isEntryStale, filterStaleOnly,
 *   verifySummary, scanOrphans, entryAge, adoptSingle
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  CredentialsManifest,
  CredentialEntry,
  CredentialType,
  filterByScope,
  filterByType,
  isEntryStale,
  filterStaleOnly,
  verifySummary,
  scanOrphans,
  entryAge,
  adoptSingle,
  writeManifest,
  readManifest,
  expandPath,
  manifestPath,
} from "../src/utils/credentials-manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFixtureFile(dir: string, name: string, content: string, mode = 0o600): string {
  const p = join(dir, name);
  writeFileSync(p, content, { mode });
  return p;
}

function makeEntry(overrides: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    path: "/tmp/test-secret",
    type: "api-key" as CredentialType,
    owners: ["test"],
    sensitivity: "medium",
    ...overrides,
  };
}

function makeManifest(entries: Record<string, CredentialEntry>): CredentialsManifest {
  return { version: 1, credentials: entries };
}

// ---------------------------------------------------------------------------
// filterByScope
// ---------------------------------------------------------------------------

describe("filterByScope", () => {
  test("matches scope substring", () => {
    const entries = {
      a: makeEntry({ scope: "dtrt-dev/ops" }),
      b: makeEntry({ scope: "newton oMLX gateway" }),
      c: makeEntry(),
    };
    const result = filterByScope(entries, "ops");
    expect(Object.keys(result).length).toBe(1);
    expect(result.a.scope).toBe("dtrt-dev/ops");
  });

  test("returns empty when no match", () => {
    const entries = { a: makeEntry({ scope: "backend" }) };
    const result = filterByScope(entries, "nonexistent");
    expect(Object.keys(result).length).toBe(0);
  });

  test("ignores entries without scope", () => {
    const entries = { a: makeEntry(), b: makeEntry({ scope: "ops" }) };
    const result = filterByScope(entries, "ops");
    expect(Object.keys(result).length).toBe(1);
    expect(result.b).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// filterByType
// ---------------------------------------------------------------------------

describe("filterByType", () => {
  test("matches exact type", () => {
    const entries = {
      a: makeEntry({ type: "api-key" }),
      b: makeEntry({ type: "github-pat-fine-grained" }),
      c: makeEntry({ type: "api-key" }),
    };
    const result = filterByType(entries, "api-key");
    expect(Object.keys(result).length).toBe(2);
    expect(result.a).toBeDefined();
    expect(result.c).toBeDefined();
  });

  test("returns empty when no match", () => {
    const entries = { a: makeEntry({ type: "api-key" }) };
    expect(Object.keys(filterByType(entries, "ssh-key")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isEntryStale
// ---------------------------------------------------------------------------

describe("isEntryStale", () => {
  test("returns false when no expires field", () => {
    expect(isEntryStale(makeEntry())).toBe(false);
  });

  test("returns true when expired", () => {
    const entry = makeEntry({ expires: "2020-01-01T00:00:00Z" });
    expect(isEntryStale(entry)).toBe(true);
  });

  test("returns false when not yet expired", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const entry = makeEntry({ expires: future });
    expect(isEntryStale(entry)).toBe(false);
  });

  test("handles invalid date gracefully", () => {
    expect(isEntryStale(makeEntry({ expires: "not-a-date" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterStaleOnly
// ---------------------------------------------------------------------------

describe("filterStaleOnly", () => {
  test("filters to only expired entries", () => {
    const entries = {
      fresh: makeEntry({ expires: new Date(Date.now() + 86400000 * 30).toISOString() }),
      stale: makeEntry({ expires: "2020-01-01T00:00:00Z" }),
      none: makeEntry(),
    };
    const result = filterStaleOnly(entries);
    expect(Object.keys(result).length).toBe(1);
    expect(result.stale).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// verifySummary
// ---------------------------------------------------------------------------

describe("verifySummary", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-s2-verify-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("categorizes OK/STALE/MISSING/DRIFT correctly", () => {
    const okFile = writeFixtureFile(tmp, "ok-key", "test-key-12345678", 0o600);
    // STALE: valid file but expired
    const staleFile = writeFixtureFile(tmp, "stale-key", "abc123def456", 0o600);
    // DRIFT: file exists but bad mode
    const driftFile = writeFixtureFile(tmp, "drift-key", "abc123def456", 0o644);
    // MISSING: file doesn't exist

    const manifest = makeManifest({
      "ok-cred": { path: okFile, type: "api-key", owners: ["test"], sensitivity: "medium" },
      "stale-cred": {
        path: staleFile,
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
        expires: "2020-01-01T00:00:00Z",
      },
      "drift-cred": { path: driftFile, type: "api-key", owners: ["test"], sensitivity: "medium" },
      "missing-cred": { path: join(tmp, "nonexistent"), type: "api-key", owners: ["test"], sensitivity: "medium" },
    });

    const summary = verifySummary(manifest);

    expect(summary.ok).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.drift).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.entries.length).toBe(4);
  });

  test("all ok entries when everything is clean", () => {
    const f1 = writeFixtureFile(tmp, "a-key", "my-key-data-1234", 0o600);
    const f2 = writeFixtureFile(tmp, "b-key", "another-key-5678", 0o600);

    const manifest = makeManifest({
      a: { path: f1, type: "api-key", owners: ["test"], sensitivity: "medium" },
      b: { path: f2, type: "api-key", owners: ["test"], sensitivity: "medium" },
    });

    const summary = verifySummary(manifest);
    expect(summary.ok).toBe(2);
    expect(summary.stale).toBe(0);
    expect(summary.missing).toBe(0);
    expect(summary.drift).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanOrphans
// ---------------------------------------------------------------------------

describe("scanOrphans", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-s2-scan-"));
    // Create a secrets dir with one file
    const secretsDir = join(tmp, "secrets");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFixtureFile(secretsDir, "registered-secret", "ghp_test12345", 0o600);
    writeFixtureFile(secretsDir, "unregistered-secret", "api-key-value-12", 0o600);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns only candidates NOT in manifest", () => {
    const dirs = {
      secretsDir: join(tmp, "secrets"),
      identityDir: join(tmp, "identity"),
      flairKeysDir: join(tmp, "flair-keys"),
      openclawConfigPath: join(tmp, "openclaw.json"),
    };

    // Manifest registers one file
    const manifest = makeManifest({
      "registered-secret": {
        path: join(tmp, "secrets", "registered-secret"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const orphans = scanOrphans(dirs, manifest);
    expect(orphans.length).toBe(1);
    expect(orphans[0].name).toBe("unregistered-secret");
  });

  test("returns empty when all candidates are registered", () => {
    const dirs = {
      secretsDir: join(tmp, "secrets"),
      identityDir: join(tmp, "identity"),
      flairKeysDir: join(tmp, "flair-keys"),
      openclawConfigPath: join(tmp, "openclaw.json"),
    };

    const manifest = makeManifest({
      "registered-secret": {
        path: join(tmp, "secrets", "registered-secret"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
      "unregistered-secret": {
        path: join(tmp, "secrets", "unregistered-secret"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    expect(scanOrphans(dirs, manifest).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// entryAge
// ---------------------------------------------------------------------------

describe("entryAge", () => {
  test("returns null when no timestamp fields", () => {
    expect(entryAge(makeEntry())).toBeNull();
  });

  test("returns 'just now' for recent timestamps", () => {
    const now = new Date();
    const entry = makeEntry({ issued: new Date(now.getTime() - 30000).toISOString() });
    const age = entryAge(entry, now);
    expect(age).toBe("just now");
  });

  test("returns minutes ago format", () => {
    const now = new Date();
    const entry = makeEntry({ issued: new Date(now.getTime() - 300000).toISOString() });
    expect(entryAge(entry, now)).toBe("5m ago");
  });

  test("returns hours ago format", () => {
    const now = new Date();
    const entry = makeEntry({ issued: new Date(now.getTime() - 3600000 * 3).toISOString() });
    expect(entryAge(entry, now)).toBe("3h ago");
  });

  test("returns days ago format", () => {
    const now = new Date();
    const entry = makeEntry({ issued: new Date(now.getTime() - 86400000 * 2).toISOString() });
    expect(entryAge(entry, now)).toBe("2d ago");
  });

  test("uses lastUsed fallback", () => {
    const now = new Date();
    const entry = makeEntry({ lastUsed: new Date(now.getTime() - 3600000).toISOString() });
    expect(entryAge(entry, now)).toBe("1h ago");
  });

  test("uses lastRotated fallback", () => {
    const now = new Date();
    const entry = makeEntry({ lastRotated: new Date(now.getTime() - 60000).toISOString() });
    expect(entryAge(entry, now)).toBe("1m ago");
  });
});

// ---------------------------------------------------------------------------
// adoptSingle
// ---------------------------------------------------------------------------

describe("adoptSingle", () => {
  let tmp: string;
  let manifestFile: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-s2-adopt-"));
    // Create a secrets dir and a test file
    const secretsDir = join(tmp, "secrets");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFixtureFile(secretsDir, "github-pat-classic-token", "ghp_fresh12345678", 0o600);

    // Set up a manifest in a temp location
    manifestFile = join(tmp, "manifest", "index.json");
    mkdirSync(dirname(manifestFile), { recursive: true, mode: 0o700 });
    writeFileSync(manifestFile, JSON.stringify({ version: 1, credentials: {} }), { mode: 0o644 });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("adopts a single file successfully", () => {
    const filePath = join(tmp, "secrets", "github-pat-classic-token");
    const result = adoptSingle(filePath);
    expect(result.name).toBe("github-pat-classic-token");
    expect(result.entry.type).toBe("github-pat-classic");
    expect(result.entry.sensitivity).toBe("medium");
  });

  test("rejects non-existent path", () => {
    expect(() => adoptSingle(join(tmp, "nonexistent"))).toThrow(/does not exist/);
  });

  test("rejects unreadable path (directory)", () => {
    expect(() => adoptSingle(tmp)).toThrow();
  });

  test("inferred type is api-key for unknown content", () => {
    const unknownFile = writeFixtureFile(join(tmp, "secrets"), "unknown-file", "some random content", 0o600);
    const result = adoptSingle(unknownFile);
    expect(result.entry.type).toBe("api-key");
  });

  test("correctly identifies github-pat-fine-grained", () => {
    const fgFile = writeFixtureFile(join(tmp, "secrets"), "github-pat-fine-grain-key", "github_pat_" + "x".repeat(82), 0o600);
    const result = adoptSingle(fgFile);
    expect(result.entry.type).toBe("github-pat-fine-grained");
    expect(result.entry.sensitivity).toBe("medium");
  });

  test("high sensitivity for harper-admin-password", () => {
    const pw = "my-super-secret-admin-password";
    const pwFile = writeFixtureFile(join(tmp, "secrets"), "flair-admin-pass-rockit", pw, 0o600);
    const result = adoptSingle(pwFile);
    expect(result.entry.type).toBe("harper-admin-password");
    expect(result.entry.sensitivity).toBe("high");
  });

  test("correctly infers discord-webhook type", () => {
    const whFile = writeFixtureFile(
      join(tmp, "secrets"),
      "pulse-discord-webhook",
      "https://discord.com/api/webhooks/123456789/abcdefghij",
      0o600,
    );
    const result = adoptSingle(whFile);
    expect(result.entry.type).toBe("discord-webhook");
  });
});
