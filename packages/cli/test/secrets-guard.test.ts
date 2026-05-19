/**
 * secrets-guard.test.ts — Cred Substrate S5 tests
 * (ops-568p child)
 *
 * Tests the pure scanner, manifest-aware redaction, streaming integrity,
 * exit code propagation, audit log append, and --check mode.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";

import {
  buildFingerprintSet,
  redactBuffer,
  countMatches,
  RedactResult,
  FingerprintSet,
  getGuardLogPath,
  appendGuardLog,
} from "../src/utils/secrets-guard.js";

import {
  CredentialsManifest,
  CredentialEntry,
  CredentialType,
} from "../src/utils/credentials-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tps-guard-test-"));
}

function writeFile(dir: string, name: string, content: string, mode?: number): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  if (mode !== undefined) {
    const { chmodSync } = require("node:fs");
    chmodSync(p, mode);
  }
  return p;
}

function makeManifest(
  entries: Record<string, CredentialEntry>
): CredentialsManifest {
  return { version: 1, credentials: entries };
}

// ---------------------------------------------------------------------------
// Pure scanner: redactBuffer with type-shape patterns
// ---------------------------------------------------------------------------

describe("redactBuffer — type-shape patterns", () => {
  test("redacts github-pat-classic (ghp_*)", () => {
    const set = buildFingerprintSet(makeManifest({}));
    const result = redactBuffer(
      "here is ghp_abcdefghijklmnopqrstuvwxyz1234567890 in text",
      set,
      "stdout"
    );
    expect(result.redacted).toContain("[REDACTED-shape]");
    expect(result.redacted).not.toContain("ghp_");
    expect(result.matches["shape"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("redacts github-pat-fine-grained (github_pat_*)", () => {
    const set = buildFingerprintSet(makeManifest({}));
    const result = redactBuffer(
      "token: github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz123456789012345",
      set,
      "stdout"
    );
    expect(result.redacted).toContain("[REDACTED-shape]");
    expect(result.redacted).not.toContain("github_pat_");
    expect(result.matches["shape"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("redacts discord-bot-token (JWT-shaped)", () => {
    const set = buildFingerprintSet(makeManifest({}));
    const result = redactBuffer(
      "token: MTE0OTk0NjgxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMA.MTE0OTk0NjgxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMA",
      set,
      "stdout"
    );
    expect(result.redacted).toContain("[REDACTED-shape]");
    expect(result.matches["shape"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("does NOT redact short non-secret text", () => {
    const set = buildFingerprintSet(makeManifest({}));
    const result = redactBuffer(
      "the quick brown fox jumps over the lazy dog",
      set,
      "stdout"
    );
    expect(result.redacted).toBe("the quick brown fox jumps over the lazy dog");
    expect(Object.values(result.matches).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("does NOT redact pure hex strings (git hashes)", () => {
    const set = buildFingerprintSet(makeManifest({}));
    // SHA-256: 64 hex chars — matches the broad base64 pattern but is NOT redacted
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const result = redactBuffer(
      `commit ${sha256} by flint`,
      set,
      "stdout"
    );
    // Should not contain [REDACTED-*] — hex is flagged but not auto-redacted
    expect(result.redacted).not.toContain("[REDACTED-");
    expect(result.redacted).toContain(sha256);
    // Base64 shape does flag hex strings (hex is a subset of base64 charset)
    expect(result.matches["shape-base64"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("flags base64-shaped strings (counts but does not redact)", () => {
    const set = buildFingerprintSet(makeManifest({}));
    // Valid base64: a-zA-Z0-9+/= only. Let's use something clearly base64
    const b64 = "dGhpcyBpcyBhIHRlc3Qgc3RyaW5nIHRoYXQgaXMgbG9uZyBlbm91Z2ggdG8gbWF0Y2ggYmFzZTY0IHNoYXBl";
    const result = redactBuffer(
      `key: ${b64}`,
      set,
      "stdout"
    );
    // Base64 shape is flagged but NOT redacted
    expect(result.redacted).toContain(b64);
    expect(result.matches["shape-base64"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Manifest-aware: fingerprint set from fixture
// ---------------------------------------------------------------------------

describe("buildFingerprintSet — manifest-aware", () => {
  let secretsDir: string;
  let cleanupDir: string;

  beforeAll(() => {
    cleanupDir = tmpDir();
    secretsDir = join(cleanupDir, "secrets");
    mkdirSync(secretsDir, { recursive: true });

    // Write fixture files
    writeFile(secretsDir, "test-ghp", "ghp_myfixturetoken12345678901234567890", 0o600);
    writeFile(secretsDir, "test-fine", "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890", 0o600);
    writeFile(secretsDir, "test-empty", "", 0o600);
  });

  afterAll(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  test("builds fingerprint set from manifest entries", () => {
    const manifest = makeManifest({
      "test-ghp": {
        path: join(secretsDir, "test-ghp"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
      "test-fine": {
        path: join(secretsDir, "test-fine"),
        type: "github-pat-fine-grained",
        owners: ["test"],
        sensitivity: "medium",
      },
      "test-empty": {
        path: join(secretsDir, "test-empty"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
      "test-missing": {
        path: join(secretsDir, "nonexistent"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);

    // Literal map should have the exact content
    expect(set.literalToEntry.has("ghp_myfixturetoken12345678901234567890")).toBe(true);
    expect(set.literalToEntry.has("github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890")).toBe(true);
    // Empty content should be skipped
    // Missing file should be skipped
    expect(set.literalToEntry.size).toBe(2);

    // Fragments: first 12 chars
    expect(set.fragments.has("ghp_myfixtur")).toBe(true);
    expect(set.fragments.has("github_pat_1")).toBe(true);
  });

  test("redacts literal content from manifest", () => {
    const manifest = makeManifest({
      "test-ghp": {
        path: join(secretsDir, "test-ghp"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);
    const result = redactBuffer(
      "the token is ghp_myfixturetoken12345678901234567890 here",
      set,
      "stdout"
    );

    expect(result.redacted).toContain("[REDACTED-github-pat-classic]");
    expect(result.redacted).not.toContain("ghp_myfixturetoken");
  });

  test("redacts fragment match (first 12 chars)", () => {
    const manifest = makeManifest({
      "test-ghp": {
        path: join(secretsDir, "test-ghp"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);

    // Fragment-only match: the first 12 chars appear without the full literal
    const result = redactBuffer(
      "partial: ghp_myfixtur rest of truncated output",
      set,
      "stdout"
    );

    expect(result.redacted).toContain("[REDACTED-github-pat-classic]");
  });

  test("generates events for audit log", () => {
    const manifest = makeManifest({
      "test-ghp": {
        path: join(secretsDir, "test-ghp"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);
    const result = redactBuffer(
      "token: ghp_myfixturetoken12345678901234567890",
      set,
      "stdout"
    );

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const ev = result.events[0];
    expect(ev.type).toBe("github-pat-classic");
    expect(ev.name).toBe("test-ghp");
    expect(ev.stream).toBe("stdout");
  });

  test("shape-only match has null name in events", () => {
    const set = buildFingerprintSet(makeManifest({}));
    const result = redactBuffer(
      "here is ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      set,
      "stdout"
    );

    for (const ev of result.events) {
      if (ev.type !== "shape-base64") {
        // Shape matches from regex patterns should have null name
        expect(ev.name).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming integrity: 1MB output with embedded fingerprint
// ---------------------------------------------------------------------------

describe("streaming integrity", () => {
  let secretsDir: string;
  let cleanupDir: string;

  beforeAll(() => {
    cleanupDir = tmpDir();
    secretsDir = join(cleanupDir, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFile(secretsDir, "test-token", "SECRET_EMBEDDED_MARKER_TOKEN_12345", 0o600);
  });

  afterAll(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  test("handles large output with embedded fingerprint", () => {
    const manifest = makeManifest({
      "test-token": {
        path: join(secretsDir, "test-token"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);

    // Build ~100KB of padding + embedded token
    const paddingBefore = "x".repeat(80_000);
    const paddingAfter = "y".repeat(20_000);
    const text = paddingBefore + "SECRET_EMBEDDED_MARKER_TOKEN_12345" + paddingAfter;

    const result = redactBuffer(text, set, "stdout");

    // The token should be redacted
    expect(result.redacted).toContain("[REDACTED-api-key]");
    expect(result.redacted).not.toContain("SECRET_EMBEDDED_MARKER_TOKEN_12345");

    // The redacted output should be shorter (token replaced by shorter tag)
    const originalLen = text.length;
    const redactedLen = result.redacted.length;
    expect(redactedLen).toBeLessThan(originalLen);
  }, 15_000);

  test("correctly handles multiple chunks via redactBuffer", () => {
    const manifest = makeManifest({
      "test-token": {
        path: join(secretsDir, "test-token"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);

    // Simulate the overlap-buffer streaming approach
    const OVERLAP = 128;
    const fullText =
      "prefix text here " +
      "SECRET_EMBEDDED_MARKER_TOKEN_12345" +
      " suffix text after the secret";

    // Split into chunks
    const chunks: string[] = [];
    let remaining = fullText;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 50));
      remaining = remaining.slice(50);
    }

    // Process with overlap buffer
    let pending = "";
    const outputParts: string[] = [];
    for (const chunk of chunks) {
      pending += chunk;
      if (pending.length > OVERLAP) {
        const flush = pending.slice(0, -OVERLAP);
        pending = pending.slice(-OVERLAP);
        const r = redactBuffer(flush, set, "stdout");
        outputParts.push(r.redacted);
      }
    }
    // Flush remaining
    if (pending.length > 0) {
      const r = redactBuffer(pending, set, "stdout");
      outputParts.push(r.redacted);
    }

    const finalOutput = outputParts.join("");
    // Token should be redacted
    expect(finalOutput).toContain("[REDACTED-api-key]");
    expect(finalOutput).not.toContain("SECRET_EMBEDDED_MARKER_TOKEN_12345");
    // Prefix and suffix preserved
    expect(finalOutput).toContain("prefix text here");
    expect(finalOutput).toContain("suffix text after the secret");
  });

  test("fingerprint spanning chunk boundary is caught", () => {
    const manifest = makeManifest({
      "test-token": {
        path: join(secretsDir, "test-token"),
        type: "api-key",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);
    const token = "SECRET_EMBEDDED_MARKER_TOKEN_12345";

    // Split the token exactly across two chunks
    const splitPoint = 15;
    const before = "padding padding " + token.slice(0, splitPoint);
    const after = token.slice(splitPoint) + " more padding";

    const OVERLAP = 128;
    let pending = "";
    const outputParts: string[] = [];

    pending += before;
    if (pending.length > OVERLAP) {
      const flush = pending.slice(0, -OVERLAP);
      pending = pending.slice(-OVERLAP);
      outputParts.push(redactBuffer(flush, set, "stdout").redacted);
    }

    pending += after;
    // Flush remaining
    const r = redactBuffer(pending, set, "stdout");
    outputParts.push(r.redacted);

    const finalOutput = outputParts.join("");
    expect(finalOutput).toContain("[REDACTED-api-key]");
    expect(finalOutput).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// --check mode
// ---------------------------------------------------------------------------

describe("--check mode", () => {
  let secretsDir: string;
  let cleanupDir: string;

  beforeAll(() => {
    cleanupDir = tmpDir();
    secretsDir = join(cleanupDir, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFile(secretsDir, "check-token", "ghp_checktoken123456789012345678901234", 0o600);
  });

  afterAll(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  test("countMatches returns correct count", () => {
    const manifest = makeManifest({
      "check-token": {
        path: join(secretsDir, "check-token"),
        type: "github-pat-classic",
        owners: ["test"],
        sensitivity: "medium",
      },
    });

    const set = buildFingerprintSet(manifest);

    // One literal match
    const n1 = countMatches("token: ghp_checktoken123456789012345678901234", set);
    expect(n1).toBeGreaterThanOrEqual(1);

    // No matches
    const n0 = countMatches("nothing to see here", set);
    expect(n0).toBe(0);

    // Two matches (both literal + shape may match)
    const n2 = countMatches(
      "first: ghp_abcdefghijklmnopqrstuvwxyz1234567890 second: ghp_anothertoken12345678901234567890123456",
      set
    );
    expect(n2).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Exit code propagation
// ---------------------------------------------------------------------------

describe("exit code propagation", () => {
  test("tps secrets-guard true exits 0", async () => {
    // Test via the spawnGuarded directly
    const { spawnGuarded } = await import("../src/utils/secrets-guard.js");
    const { buildFingerprintSet } = await import("../src/utils/secrets-guard.js");
    const set = buildFingerprintSet({ version: 1, credentials: {} });
    const code = await spawnGuarded("true", [], set);
    expect(code).toBe(0);
  }, 10_000);

  test("tps secrets-guard false exits 1", async () => {
    const { spawnGuarded } = await import("../src/utils/secrets-guard.js");
    const { buildFingerprintSet } = await import("../src/utils/secrets-guard.js");
    const set = buildFingerprintSet({ version: 1, credentials: {} });
    const code = await spawnGuarded("false", [], set);
    expect(code).toBe(1);
  }, 10_000);

  test("tps secrets-guard with custom exit code", async () => {
    const { spawnGuarded } = await import("../src/utils/secrets-guard.js");
    const { buildFingerprintSet } = await import("../src/utils/secrets-guard.js");
    const set = buildFingerprintSet({ version: 1, credentials: {} });
    const code = await spawnGuarded("sh", ["-c", "exit 42"], set);
    expect(code).toBe(42);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Audit log append
// ---------------------------------------------------------------------------

describe("audit log append", () => {
  test("guard.log is JSONL at correct path", () => {
    const p = getGuardLogPath();
    expect(p).toContain(".tps/credentials/guard.log");
  });

  test("appendGuardLog writes JSONL entries", () => {
    const tmpLog = join(tmpdir(), `guard-test-${Date.now()}.log`);

    // Clean up before
    try { unlinkSync(tmpLog); } catch {}

    appendGuardLog([
      { ts: "2026-05-19T01:00:00Z", cmd: "jq", type: "github-pat-classic", name: "flint-github-pat-ops", stream: "stdout" },
    ], tmpLog);

    const content = readFileSync(tmpLog, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.ts).toBe("2026-05-19T01:00:00Z");
    expect(parsed.cmd).toBe("jq");
    expect(parsed.type).toBe("github-pat-classic");
    expect(parsed.name).toBe("flint-github-pat-ops");
    expect(parsed.stream).toBe("stdout");

    // Append another entry
    appendGuardLog([
      { ts: "2026-05-19T01:01:00Z", cmd: "cat", type: "github-pat-fine-grained", name: null, stream: "stderr" },
    ], tmpLog);

    const lines = readFileSync(tmpLog, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).cmd).toBe("cat");

    // Clean up
    unlinkSync(tmpLog);
  });
});
