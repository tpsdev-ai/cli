import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseTPSReport } from "../src/schema/report.js";
import { generateWorkspace, writeWorkspace } from "../src/generators/openclaw.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("generateWorkspace", () => {
  test("generates all expected files", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    const expectedFiles = [
      "SOUL.md",
      "IDENTITY.md",
      "AGENTS.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
    ];

    for (const f of expectedFiles) {
      expect(f in result.files).toBe(true);
      expect(result.files[f]!.length).toBeGreaterThan(0);
    }
  });

  test("uses custom name when provided", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const result = generateWorkspace(report, {
      name: "CustomName",
      workspace: "/tmp/tps-gen-test",
    });

    expect(result.config.id).toBe("customname");
    expect(result.config.name).toBe("CustomName");
  });

  test("uses default_name from report when no custom name given", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    expect(result.config.id).toBe("testy");
    expect(result.config.name).toBe("Testy");
  });

  test("generates valid config shape", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    expect(result.config.id).toBe("fulltest");
    expect(result.config.name).toBe("FullTest");
    expect(result.config.workspace).toBe("/tmp/tps-gen-test");
    // model moved to defaults
    expect(result.config.model).toBeUndefined();
    // thinking: "low" should be included (non-default)
    expect(result.config.thinking).toBe("low");
  });

  test("omits thinking when set to off (default)", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    expect(result.config.thinking).toBeUndefined();
  });

  test("SOUL.md contains agent name", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    expect(result.files["SOUL.md"]).toContain("FullTest");
  });

  test("SOUL.md uses custom name when --name override provided", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    const result = generateWorkspace(report, { name: "Scout", workspace: "/tmp/tps-gen-test" });

    expect(result.files["SOUL.md"]).toContain("Scout");
    expect(result.files["IDENTITY.md"]).toContain("Scout");
  });

  test("IDENTITY.md contains emoji", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-gen-test" });

    expect(result.files["IDENTITY.md"]).toContain("🧪");
  });
});

describe("writeWorkspace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes all files to disk", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const generated = generateWorkspace(report, { workspace: tmpDir });
    const written = writeWorkspace(generated);

    expect(written.length).toBe(9); // now includes package.json + lockfile + OPERATIONS.md
    for (const name of written) {
      const filePath = join(tmpDir, name);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8").length).toBeGreaterThan(0);
    }
  });

  test("creates nested workspace directory", () => {
    const nestedDir = join(tmpDir, "deep", "nested", "workspace");
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const generated = generateWorkspace(report, { workspace: nestedDir });
    writeWorkspace(generated);

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, "SOUL.md"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S1.6 — workspace path traversal via crafted report name
// ─────────────────────────────────────────────────────────────────────────────
describe("generateWorkspace: S1.6 — agent name sanitization", () => {
  test("strips path separators and dots from derived agent ID", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    // Override default_name with a traversal attempt
    const crafted = { ...report, identity: { ...report.identity, default_name: "../../etc/passwd" } };
    const result = generateWorkspace(crafted);
    // agentId must not contain / or .
    const id = result.config.id as string;
    expect(id).not.toContain("..");
    expect(id).not.toContain("/");
    expect(id).not.toContain(".");
    // workspace path must not contain traversal sequences
    const { resolve } = require("node:path");
    expect(resolve(result.workspacePath)).not.toContain("..");
  });

  test("strips slashes from names like '../../.ssh/'", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const crafted = { ...report, identity: { ...report.identity, default_name: "../../.ssh/" } };
    const result = generateWorkspace(crafted);
    const id = result.config.id as string;
    expect(id).toMatch(/^[a-z0-9\-_]+$/);
  });

  test("falls back to 'unknown' when sanitized ID is empty", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const crafted = { ...report, identity: { ...report.identity, default_name: "../../" } };
    // sanitizeTPSReport converts "../../" -> "unknown", so generateWorkspace proceeds
    const result = generateWorkspace(crafted);
    expect(result.config.id).toBe("unknown");
    expect(result.config.name).toBe("unknown");
  });

  test("preserves valid names unchanged", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const result = generateWorkspace(report, { workspace: "/tmp/tps-test-valid" });
    expect(result.config.id).toBe("testy");
  });

  test("three-level traversal does not escape ~/.openclaw", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const crafted = { ...report, identity: { ...report.identity, default_name: "../../../home/evil" } };
    // After sanitization agentId has no .. so path stays under .openclaw
    const result = generateWorkspace(crafted);
    const { resolve } = require("node:path");
    expect(resolve(result.workspacePath)).not.toContain("..");
  });
});

describe("generateWorkspace: ops-12.3 — supply chain hygiene", () => {
  test("generates package.json and lockfile with safe defaults", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    const result = generateWorkspace(report);
    
    // Check files exist in the output map
    expect(result.files["package.json"]).toBeDefined();
    expect(result.files["package-lock.json"]).toBeDefined();

    const pkg = JSON.parse(result.files["package.json"]);
    const lock = JSON.parse(result.files["package-lock.json"]);

    // Safe defaults check
    expect(pkg.private).toBe(true);
    expect(pkg.scripts).toEqual({}); // No lifecycle scripts
    expect(pkg.dependencies).toEqual({}); // Empty deps (pinned if we added them)
    
    // Lockfile check
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.name).toBe(pkg.name);
  });
});
