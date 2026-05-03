/**
 * pat-rotate.test.ts — Unit tests for the tps secrets rotate-github-pat /
 * list-github-pats helpers (ops-njgl).
 *
 * Validates the pure helpers (normalizeToken, validateTokenShape) — the
 * action callbacks themselves rely on stdin + network + filesystem and are
 * tested via integration when run against a real GitHub PAT.
 */

import { describe, test, expect } from "bun:test";
import { normalizeToken, validateTokenShape } from "../src/commands/pat-rotate.js";

describe("normalizeToken", () => {
  test("strips trailing newline (common when piped from echo / file with EOL)", () => {
    expect(normalizeToken("github_pat_abc\n")).toBe("github_pat_abc");
  });

  test("strips leading + trailing whitespace", () => {
    expect(normalizeToken("  github_pat_abc  ")).toBe("github_pat_abc");
  });

  test("preserves internal characters as-is", () => {
    expect(normalizeToken("github_pat_a-b-c-1-2_3")).toBe("github_pat_a-b-c-1-2_3");
  });

  test("returns empty string when input is whitespace-only", () => {
    expect(normalizeToken("   \n\t  ")).toBe("");
  });
});

describe("validateTokenShape", () => {
  test("accepts a fine-grained PAT (github_pat_ prefix, 93 chars)", () => {
    const t = "github_pat_" + "x".repeat(82);
    expect(validateTokenShape(t)).toBeNull();
  });

  test("accepts a classic PAT (ghp_ prefix, 40 chars)", () => {
    const t = "ghp_" + "x".repeat(36);
    expect(validateTokenShape(t)).toBeNull();
  });

  test("accepts ghs_ (server-to-server) and gho_ (oauth) prefixes", () => {
    expect(validateTokenShape("ghs_" + "x".repeat(36))).toBeNull();
    expect(validateTokenShape("gho_" + "x".repeat(36))).toBeNull();
  });

  test("rejects empty token", () => {
    expect(validateTokenShape("")).toMatch(/empty/);
  });

  test("rejects too-short token (truncated paste)", () => {
    expect(validateTokenShape("ghp_short")).toMatch(/too short/);
  });

  test("rejects too-long token (clipboard contains rest of file)", () => {
    expect(validateTokenShape("github_pat_" + "x".repeat(300))).toMatch(/too long/);
  });

  test("rejects token without recognized prefix", () => {
    // 50 chars, no GitHub prefix — should fail prefix check (not length check)
    expect(validateTokenShape("xoxb-not-a-github-token-" + "x".repeat(26))).toMatch(/recognized GitHub PAT prefix/);
  });

  test("rejects token containing whitespace (paste mishap)", () => {
    expect(validateTokenShape("github_pat_with space" + "x".repeat(30))).toMatch(/whitespace or quotes/);
  });

  test("rejects token containing quotes (copied from JSON)", () => {
    expect(validateTokenShape('github_pat_"quoted' + "x".repeat(30))).toMatch(/whitespace or quotes/);
  });

  test("rejects token containing backticks (shell escape)", () => {
    expect(validateTokenShape("github_pat_`tick" + "x".repeat(30))).toMatch(/whitespace or quotes/);
  });
});
