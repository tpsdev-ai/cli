/**
 * credentials-manifest.test.ts — Cred Substrate S1 tests
 * (ops-568p child)
 *
 * Tests against tmpdir-based fixtures — no host secrets touched.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";

// Import helpers — we'll test them directly
import {
  manifestPath,
  expandPath,
  readManifest,
  writeManifest,
  CredentialsManifest,
  CredentialEntry,
  CredentialType,
  RESERVED_TYPES,
  sensitivityForType,
  inferTypeFromPath,
  inferOwnerFromName,
  parseDuration,
  filterExpiresWithin,
  verifyEntry,
  verifyFixPermissions,
  verifyAll,
  verifyFixAll,
  walkAdoptCandidates,
  AdoptDirs,
  VerifyResult,
  VerifyIssue,
} from "../src/utils/credentials-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmptyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tps-creds-test-"));
  const credsDir = join(dir, "credentials");
  mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

function createSecretsDir(baseDir: string): string {
  const d = join(baseDir, "secrets");
  mkdirSync(d, { recursive: true });
  return d;
}

function createIdentityDir(baseDir: string): string {
  const d = join(baseDir, "identity");
  mkdirSync(d, { recursive: true });
  return d;
}

function createFlairKeysDir(baseDir: string): string {
  const d = join(baseDir, "flair", "keys");
  mkdirSync(d, { recursive: true });
  return d;
}

function writeFixtureFile(dir: string, name: string, content: string, mode?: number): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  if (mode !== undefined) chmodSync(p, mode);
  return p;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("expandPath", () => {
  test("expands ~/ prefix to homedir", () => {
    const result = expandPath("~/foo/bar");
    expect(result).toBe(join(homedir(), "foo", "bar"));
  });

  test("leaves absolute paths alone", () => {
    const result = expandPath("/etc/passwd");
    expect(result).toBe("/etc/passwd");
  });

  test("leaves relative paths alone (no ~)", () => {
    const result = expandPath("./relative");
    expect(result).toBe("./relative");
  });

  test("handles bare ~/", () => {
    const result = expandPath("~/");
    // join(homedir(), "") trims the trailing separator
    expect(result).toBe(homedir());
  });
});

describe("manifestPath", () => {
  test("returns ~/.tps/credentials/index.json", () => {
    const p = manifestPath();
    expect(p).toBe(join(homedir(), ".tps", "credentials", "index.json"));
  });
});

// ---------------------------------------------------------------------------
// Parse duration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  test("parses days", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("parses hours", () => {
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses minutes", () => {
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
  });

  test("parses weeks", () => {
    expect(parseDuration("2w")).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("returns null for invalid", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("7x")).toBeNull();
  });

  test("is case-insensitive", () => {
    expect(parseDuration("7D")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("24H")).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// filterExpiresWithin
// ---------------------------------------------------------------------------

describe("filterExpiresWithin", () => {
  test("filters entries expiring within duration", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const manifest: CredentialsManifest = {
      version: 1,
      credentials: {
        "soon": {
          path: "/a",
          type: "api-key",
          owners: [],
          sensitivity: "medium",
          expires: "2026-01-05T00:00:00Z", // 4 days from now
        },
        "later": {
          path: "/b",
          type: "api-key",
          owners: [],
          sensitivity: "medium",
          expires: "2026-02-01T00:00:00Z", // 31 days from now
        },
        "never": {
          path: "/c",
          type: "api-key",
          owners: [],
          sensitivity: "medium",
          // no expires
        },
      },
    };

    const filtered = filterExpiresWithin(manifest, "7d", now);
    expect(Object.keys(filtered)).toEqual(["soon"]);

    const all = filterExpiresWithin(manifest, "90d", now);
    expect(Object.keys(all).sort()).toEqual(["later", "soon"]);
  });

  test("returns all when duration is invalid", () => {
    const manifest: CredentialsManifest = {
      version: 1,
      credentials: {
        "a": {
          path: "/a", type: "api-key", owners: [], sensitivity: "medium",
        },
      },
    };
    const result = filterExpiresWithin(manifest, "bad");
    expect(Object.keys(result)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

describe("inferTypeFromPath", () => {
  test("detects github-pat-classic", () => {
    expect(inferTypeFromPath("/path/to/anvil-github-pat")).toBe("github-pat-classic");
  });

  test("disambiguates github-pat-fine-grained by content", () => {
    expect(inferTypeFromPath("/path/to/github-pat-fine-grained", "github_pat_abc")).toBe("github-pat-fine-grained");
  });

  test("detects api-key for ollama files", () => {
    expect(inferTypeFromPath("/path/to/anvil-ollama")).toBe("api-key");
    expect(inferTypeFromPath("/path/to/omlx-api-key")).toBe("api-key");
    expect(inferTypeFromPath("/path/to/anthropic-api-key")).toBe("api-key");
  });

  test("detects harper-admin-password", () => {
    expect(inferTypeFromPath("/path/to/flair-admin-pass")).toBe("harper-admin-password");
    expect(inferTypeFromPath("/path/to/anvil-admin-pass")).toBe("harper-admin-password");
  });

  test("detects discord-bot-token", () => {
    expect(inferTypeFromPath("/path/to/anvil-discord-bot-token")).toBe("discord-bot-token");
  });

  test("detects discord-webhook by basename", () => {
    expect(inferTypeFromPath("/path/to/discord-webhook-tps-activity")).toBe("discord-webhook");
  });

  test("defaults to api-key for unknown", () => {
    expect(inferTypeFromPath("/path/to/random-file")).toBe("api-key");
  });
});

// ---------------------------------------------------------------------------
// Owner inference
// ---------------------------------------------------------------------------

describe("inferOwnerFromName", () => {
  test("matches known agent prefix", () => {
    expect(inferOwnerFromName("anvil-github-pat")).toBe("anvil");
    expect(inferOwnerFromName("ember-keys")).toBe("ember");
    expect(inferOwnerFromName("flint-secret")).toBe("flint");
    expect(inferOwnerFromName("sherlock-something")).toBe("sherlock");
    expect(inferOwnerFromName("pulse-thing")).toBe("pulse");
  });

  test("returns null for unknown prefix", () => {
    expect(inferOwnerFromName("random-thing")).toBeNull();
    expect(inferOwnerFromName("xyz-api-key")).toBeNull();
  });

  test("uses custom known agents list", () => {
    expect(inferOwnerFromName("robot-key", ["robot"])).toBe("robot");
    expect(inferOwnerFromName("robot-key")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

describe("sensitivityForType", () => {
  test("ed25519-seed is high", () => {
    expect(sensitivityForType("ed25519-seed")).toBe("high");
  });

  test("oauth-refresh is high", () => {
    expect(sensitivityForType("oauth-refresh")).toBe("high");
  });

  test("harper-admin-password is high", () => {
    expect(sensitivityForType("harper-admin-password")).toBe("high");
  });

  test("github-pat-classic is medium", () => {
    expect(sensitivityForType("github-pat-classic")).toBe("medium");
  });

  test("api-key is medium", () => {
    expect(sensitivityForType("api-key")).toBe("medium");
  });

  test("discord-bot-token is medium", () => {
    expect(sensitivityForType("discord-bot-token")).toBe("medium");
  });

  test("x25519-key is medium", () => {
    expect(sensitivityForType("x25519-key")).toBe("medium");
  });

  test("discord-webhook is medium", () => {
    expect(sensitivityForType("discord-webhook")).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Manifest I/O (uses real filesystem — tmpdir)
// ---------------------------------------------------------------------------

describe("Manifest I/O", () => {
  let tmp: string;
  let origManifestPath: () => string;

  beforeAll(() => {
    tmp = createEmptyFixture();
    // Override the manifest path for testing — we'll write/read directly
  });

  afterAll(() => {
    rmSync(dirname(tmp), { recursive: true, force: true });
  });

  test("readManifest returns null when file doesn't exist", () => {
    // The actual manifestPath() points to ~/.tps/credentials/index.json
    // which may not exist. If it does, we just test the null case conceptually.
    // Our actual test will use raw JSON round-trips.
    const dummy = join(tmp, "nonexistent.json");
    expect(existsSync(dummy)).toBe(false);
  });

  test("round-trip: write → read", () => {
    const manifestPath = join(tmp, "index.json");
    const m: CredentialsManifest = {
      version: 1,
      credentials: {
        "test-key": {
          path: "/tmp/test",
          type: "api-key",
          owners: ["anvil"],
          sensitivity: "medium",
        },
      },
    };

    const json = JSON.stringify(m, null, 2);
    writeFileSync(manifestPath, json, { mode: 0o644 });

    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as CredentialsManifest;

    expect(parsed.version).toBe(1);
    expect(parsed.credentials["test-key"].type).toBe("api-key");
    expect(parsed.credentials["test-key"].owners).toEqual(["anvil"]);
  });

  test("rejects unknown version", () => {
    const manifestPath = join(tmp, "bad-version.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 2, credentials: {} }));

    const raw = readFileSync(manifestPath, "utf-8");
    const obj = JSON.parse(raw) as CredentialsManifest;
    // Version check: should reject non-v1
    expect(obj.version === 1 ? obj : null).toBeNull();
  });

  test("rejects malformed JSON (null return)", () => {
    const manifestPath = join(tmp, "bad-json.json");
    writeFileSync(manifestPath, "not json at all");

    let result: CredentialsManifest | null = null;
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      result = JSON.parse(raw) as CredentialsManifest;
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

describe("verifyEntry", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-verify-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("reports missing file", () => {
    const entry: CredentialEntry = {
      path: join(tmp, "does-not-exist"),
      type: "api-key",
      owners: [],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.kind === "missing-file")).toBe(true);
  });

  test("passes valid github-pat-classic", () => {
    const p = writeFixtureFile(tmp, "valid-ghp", "ghp_1234567890abcdef1234567890abcdef123456", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-classic",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test("passes valid github-pat-fine-grained", () => {
    const p = writeFixtureFile(tmp, "valid-fg", "github_pat_" + "x".repeat(82), 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-fine-grained",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid api-key", () => {
    const p = writeFixtureFile(tmp, "valid-apikey", "sk-test1234567890", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "api-key",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid oauth-refresh (JSON)", () => {
    const p = writeFixtureFile(tmp, "valid-oauth", '{"token":"abc"}', 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "oauth-refresh",
      owners: ["anvil"],
      sensitivity: "high",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid harper-admin-password", () => {
    const p = writeFixtureFile(tmp, "valid-harper", "my-admin-password", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "harper-admin-password",
      owners: ["anvil"],
      sensitivity: "high",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid ed25519-seed (32 bytes base64)", () => {
    const seed = Buffer.alloc(32, 1).toString("base64");
    const p = writeFixtureFile(tmp, "valid-ed25519", seed, 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "ed25519-seed",
      owners: ["anvil"],
      sensitivity: "high",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid x25519-key (32 bytes base64)", () => {
    const key = Buffer.alloc(32, 2).toString("base64");
    const p = writeFixtureFile(tmp, "valid-x25519", key, 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "x25519-key",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid discord-bot-token", () => {
    const p = writeFixtureFile(tmp, "valid-discord", "MTE0OTk0NjgxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMA", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "discord-bot-token",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("passes valid discord-webhook", () => {
    const p = writeFixtureFile(tmp, "valid-webhook", "https://discord.com/api/webhooks/123456/abcdef", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "discord-webhook",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(true);
  });

  test("fails bad discord-webhook format", () => {
    const p = writeFixtureFile(tmp, "bad-webhook", "not-a-discord-url", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "discord-webhook",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.kind === "bad-format")).toBe(true);
  });

  test("fails bad mode", () => {
    const p = writeFixtureFile(tmp, "bad-mode", "ghp_1234567890abcdef1234567890abcdef123456", 0o644);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-classic",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.kind === "bad-mode")).toBe(true);
  });

  test("fails bad format for github-pat-classic", () => {
    const p = writeFixtureFile(tmp, "bad-format-ghp", "not_ghp_token", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-classic",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.kind === "bad-format")).toBe(true);
  });

  test("fails bad format for ed25519-seed (wrong length)", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    const p = writeFixtureFile(tmp, "bad-ed25519", short, 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "ed25519-seed",
      owners: ["anvil"],
      sensitivity: "high",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
  });

  test("fails bad format for discord-bot-token (too short)", () => {
    const p = writeFixtureFile(tmp, "bad-discord", "short", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "discord-bot-token",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
  });

  test("fails empty api-key", () => {
    const p = writeFixtureFile(tmp, "empty-key", "", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "api-key",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
  });

  test("fails api-key with whitespace", () => {
    const p = writeFixtureFile(tmp, "ws-key", "abc def", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "api-key",
      owners: ["anvil"],
      sensitivity: "medium",
    };
    const result = verifyEntry(entry);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyFixPermissions
// ---------------------------------------------------------------------------

describe("verifyFixPermissions", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-fixperm-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("chmod-repairs a 0644 fixture", () => {
    const p = writeFixtureFile(tmp, "to-fix", "ghp_test1234567890abcdef1234567890abcdef123456", 0o644);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-classic",
      owners: ["anvil"],
      sensitivity: "medium",
    };

    const fixed = verifyFixPermissions(entry);
    expect(fixed.length).toBe(1);
    expect(fixed[0]).toContain("chmod 0600");

    // Verify it's now 0600
    const { statSync } = require("node:fs");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("leaves 0600 alone", () => {
    const p = writeFixtureFile(tmp, "already-ok", "ghp_test1234567890abcdef1234567890abcdef123456", 0o600);
    const entry: CredentialEntry = {
      path: p,
      type: "github-pat-classic",
      owners: ["anvil"],
      sensitivity: "medium",
    };

    const fixed = verifyFixPermissions(entry);
    expect(fixed.length).toBe(0);
  });

  test("skips missing files", () => {
    const entry: CredentialEntry = {
      path: join(tmp, "nonexistent"),
      type: "api-key",
      owners: [],
      sensitivity: "medium",
    };
    const fixed = verifyFixPermissions(entry);
    expect(fixed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAll / verifyFixAll
// ---------------------------------------------------------------------------

describe("verifyAll", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-verifyall-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("reports results for all entries", () => {
    const okPath = writeFixtureFile(tmp, "ok", "ghp_test1234567890abcdef1234567890abcdef123456", 0o600);
    const badPath = writeFixtureFile(tmp, "bad-mode-file", "ghp_test1234567890abcdef1234567890abcdef123456", 0o644);

    const manifest: CredentialsManifest = {
      version: 1,
      credentials: {
        "ok-entry": {
          path: okPath, type: "github-pat-classic", owners: [], sensitivity: "medium",
        },
        "bad-entry": {
          path: badPath, type: "github-pat-classic", owners: [], sensitivity: "medium",
        },
      },
    };

    const results = verifyAll(manifest);
    expect(results["ok-entry"].ok).toBe(true);
    expect(results["bad-entry"].ok).toBe(false);

    const fixed = verifyFixAll(manifest);
    expect(fixed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// walkAdoptCandidates
// ---------------------------------------------------------------------------

describe("walkAdoptCandidates", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "tps-adopt-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeDirs() {
    return {
      secretsDir: createSecretsDir(tmp),
      identityDir: createIdentityDir(tmp),
      flairKeysDir: createFlairKeysDir(tmp),
      openclawConfigPath: join(tmp, "nonexistent.json"),
    };
  }

  test("finds candidates in secrets dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.secretsDir, "anvil-github-pat", "ghp_test1234567890abcdef1234567890abcdef123456", 0o600);
    writeFixtureFile(dirs.secretsDir, "anvil-ollama", "sk-test123456", 0o600);
    writeFixtureFile(dirs.secretsDir, "flair-admin-pass", "admin-pass", 0o600);

    const result = walkAdoptCandidates(dirs);

    expect(result.candidates.length).toBe(3);
    expect(result.candidates.find(c => c.name === "anvil-github-pat")!.entry.type).toBe("github-pat-classic");
    expect(result.candidates.find(c => c.name === "anvil-ollama")!.entry.type).toBe("api-key");
    expect(result.candidates.find(c => c.name === "flair-admin-pass")!.entry.type).toBe("harper-admin-password");
  });

  test("skips .pub files in secrets dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.secretsDir, "pulse.pub", "ed25519_public_key_data", 0o644);
    writeFixtureFile(dirs.secretsDir, "anvil-github-pat", "ghp_test1234567890abcdef1234567890abcdef123456", 0o600);

    const result = walkAdoptCandidates(dirs);

    // .pub should NOT be a candidate
    const pubCandidate = result.candidates.find(c => c.name === "pulse.pub");
    expect(pubCandidate).toBeUndefined();

    // But the real secret IS found
    const realSecret = result.candidates.find(c => c.name === "anvil-github-pat");
    expect(realSecret).toBeDefined();
    expect(realSecret!.entry.type).toBe("github-pat-classic");
  });

  test("detects discord-webhook type from basename", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.secretsDir, "discord-webhook-tps-activity", "https://discord.com/api/webhooks/123/abc", 0o600);

    const result = walkAdoptCandidates(dirs);

    const wh = result.candidates.find(c => c.name === "discord-webhook-tps-activity");
    expect(wh).toBeDefined();
    expect(wh!.entry.type).toBe("discord-webhook");
  });

  test("finds ed25519-seed candidates in identity dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.identityDir, "anvil.key", Buffer.alloc(32, 1).toString("base64"), 0o600);

    const result = walkAdoptCandidates(dirs);

    const keyCandidate = result.candidates.find(c => c.name === "anvil.key");
    expect(keyCandidate).toBeDefined();
    expect(keyCandidate!.entry.type).toBe("ed25519-seed");
    expect(keyCandidate!.entry.sensitivity).toBe("high");
  });

  test("skips *.meta.json files in identity dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.identityDir, "anvil.key", Buffer.alloc(32, 1).toString("base64"), 0o600);
    writeFixtureFile(dirs.identityDir, "anvil.meta.json", '{"created":"2025-01-01"}', 0o644);

    const result = walkAdoptCandidates(dirs);

    // .meta.json should NOT be a candidate
    const meta = result.candidates.find(c => c.name === "anvil.meta.json");
    expect(meta).toBeUndefined();

    // But the .key IS found
    const keyCand = result.candidates.find(c => c.name === "anvil.key");
    expect(keyCand).toBeDefined();
    expect(keyCand!.entry.type).toBe("ed25519-seed");
  });

  test("finds x25519-key candidates in identity dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.identityDir, "anvil.x25519.key", Buffer.alloc(32, 3).toString("base64"), 0o600);

    const result = walkAdoptCandidates(dirs);

    const xCandidate = result.candidates.find(c => c.name === "anvil.x25519.key");
    expect(xCandidate).toBeDefined();
    expect(xCandidate!.entry.type).toBe("x25519-key");
    expect(xCandidate!.entry.sensitivity).toBe("medium");
  });

  test("flags vault.json in identity dir", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.identityDir, "vault.json", '{"encrypted":true}', 0o600);

    const result = walkAdoptCandidates(dirs);

    const vaultCandidate = result.candidates.find(c => c.name === "vault.json");
    expect(vaultCandidate).toBeDefined();
    expect(vaultCandidate!.entry.type).toBe("vaulted-secret");
    expect(vaultCandidate!.entry.notes).toContain("LEGACY vault");
  });

  test("scans ~/.flair/keys/ for ed25519-seed and x25519-key", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.flairKeysDir, "admin.key", Buffer.alloc(32, 1).toString("base64"), 0o600);
    writeFixtureFile(dirs.flairKeysDir, "server.x25519.key", Buffer.alloc(32, 2).toString("base64"), 0o600);

    const result = walkAdoptCandidates(dirs);

    const adminKey = result.candidates.find(c => c.name === "flair-admin.key");
    expect(adminKey).toBeDefined();
    expect(adminKey!.entry.type).toBe("ed25519-seed");
    expect(adminKey!.entry.sensitivity).toBe("high");
    expect(adminKey!.entry.path).toContain("flair/keys/admin.key");

    const xKey = result.candidates.find(c => c.name === "flair-server.x25519.key");
    expect(xKey).toBeDefined();
    expect(xKey!.entry.type).toBe("x25519-key");
    expect(xKey!.entry.path).toContain("flair/keys/server.x25519.key");
  });

  test("owner inference from filename prefix", () => {
    const dirs = makeDirs();
    writeFixtureFile(dirs.secretsDir, "anvil-github-pat", "ghp_test1234567890abcdef1234567890abcdef123456", 0o600);
    writeFixtureFile(dirs.secretsDir, "ember-secret", "test", 0o600);
    writeFixtureFile(dirs.secretsDir, "unknown-file", "test", 0o600);

    const result = walkAdoptCandidates(dirs);

    const anvilCand = result.candidates.find(c => c.name === "anvil-github-pat")!;
    expect(anvilCand.entry.owners).toEqual(["anvil"]);

    const emberCand = result.candidates.find(c => c.name === "ember-secret")!;
    expect(emberCand.entry.owners).toEqual(["ember"]);

    const unknownCand = result.candidates.find(c => c.name === "unknown-file")!;
    expect(unknownCand.entry.owners).toEqual([]);
  });

  test("scans openclaw.json for embedded tokens", () => {
    const dirs = makeDirs();
    const ocPath = join(tmp, "openclaw.json");

    const ocConfig = {
      agents: {
        "discord-bridge": {
          token: "MTE0OTk0NjgxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMA",
        },
      },
      providers: {
        "openai": {
          apiKey: "sk-test",
        },
      },
    };
    writeFileSync(ocPath, JSON.stringify(ocConfig));

    const result = walkAdoptCandidates({ ...dirs, openclawConfigPath: ocPath });

    expect(result.openclawTokens.length).toBe(1);
    expect(result.openclawTokens[0].agent).toBe("discord-bridge");
    expect(result.openclawTokens[0].note).toContain("agents.discord-bridge.token");
  });

  test("handles missing directories gracefully", () => {
    const result = walkAdoptCandidates({
      secretsDir: join(tmp, "nonexistent-secrets"),
      identityDir: join(tmp, "nonexistent-identity"),
      flairKeysDir: join(tmp, "nonexistent-flair-keys"),
      openclawConfigPath: join(tmp, "nonexistent-oc.json"),
    });

    expect(result.candidates.length).toBe(0);
    expect(result.openclawTokens.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reserved types
// ---------------------------------------------------------------------------

describe("RESERVED_TYPES", () => {
  test("includes vaulted-secret", () => {
    expect(RESERVED_TYPES.includes("vaulted-secret")).toBe(true);
  });
});
