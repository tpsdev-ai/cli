import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TPSReportSchema, parseTPSReport } from "../src/schema/report.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("TPSReportSchema", () => {
  test("parses a minimal valid report", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    expect(report.name).toBe("Test Agent");
    expect(report.description).toBe("A minimal valid TPS report for testing.");
    expect(report.identity.default_name).toBe("Testy");
    // Check defaults applied
    expect(report.identity.emoji).toBe("📋");
    expect(report.flair).toEqual([]);
    expect(report.model.default).toBe("reasoning");
    expect(report.tools.required).toEqual([]);
    expect(report.boundaries.can_commit).toBe(false);
    expect(report.memory.private).toBe(true);
    expect(report.openclaw.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(report.openclaw.thinking).toBe("off");
  });

  test("parses a fully-specified report", () => {
    const report = parseTPSReport(join(FIXTURES, "valid-full.tps"));
    expect(report.name).toBe("Full Test Agent");
    expect(report.identity.emoji).toBe("🧪");
    expect(report.flair).toEqual(["testing", "validation", "quality"]);
    expect(report.tools.required).toEqual(["file-ops", "git"]);
    expect(report.boundaries.can_commit).toBe(true);
    expect(report.boundaries.can_send_external).toBe(false);
    expect(report.communication.handoff_targets).toEqual(["ops"]);
    expect(report.openclaw.thinking).toBe("low");
  });

  test("rejects missing name field", () => {
    expect(() =>
      parseTPSReport(join(FIXTURES, "invalid-missing-name.tps"))
    ).toThrow(/name/i);
  });

  test("rejects empty name string", () => {
    expect(() =>
      parseTPSReport(join(FIXTURES, "invalid-empty-name.tps"))
    ).toThrow(/name/i);
  });

  test("rejects bad YAML", () => {
    expect(() =>
      parseTPSReport(join(FIXTURES, "invalid-bad-yaml.tps"))
    ).toThrow(/YAML|parse/i);
  });

  test("rejects nonexistent file", () => {
    expect(() =>
      parseTPSReport("/tmp/does-not-exist.tps")
    ).toThrow(/read|file/i);
  });

  test("schema validates raw objects correctly", () => {
    const result = TPSReportSchema.safeParse({
      name: "Inline Test",
      description: "Created inline",
      identity: { default_name: "Inliner" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe("1"); // default
    }
  });

  test("schema rejects object without identity.default_name", () => {
    const result = TPSReportSchema.safeParse({
      name: "No Identity",
      description: "Missing identity.default_name",
      identity: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("parseTPSReport guardrails", () => {
  test("rejects report larger than 64KB", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-schema-size-"));
    try {
      const file = join(dir, "too-large.tps");
      const huge = "a".repeat(70_000);
      writeFileSync(
        file,
        `name: Big\ndescription: ${huge}\nidentity:\n  default_name: BigAgent\n`,
        "utf-8"
      );
      expect(() => parseTPSReport(file)).toThrow(/64KB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects report with too many YAML alias references", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-schema-alias-"));
    try {
      const file = join(dir, "too-many-aliases.tps");
      const aliases = Array.from({ length: 21 }, () => "*a").join(" ");
      writeFileSync(
        file,
        `name: Alias\ndescription: ${aliases}\nidentity:\n  default_name: AliasAgent\nanchor: &a x\n`,
        "utf-8"
      );
      expect(() => parseTPSReport(file)).toThrow(/too many YAML aliases/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("built-in personas", () => {
  const personas = ["developer", "designer", "support", "ea", "ops", "strategy"];

  for (const persona of personas) {
    test(`${persona}.tps parses without errors`, () => {
      const report = parseTPSReport(join(FIXTURES, "..", "..", "personas", `${persona}.tps`));
      expect(report.name).toBeTruthy();
      expect(report.description).toBeTruthy();
      expect(report.identity.default_name).toBeTruthy();
    });
  }
});
