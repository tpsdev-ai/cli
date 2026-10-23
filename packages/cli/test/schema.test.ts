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

  test("applies the zod 3 default output for omitted blocks", () => {
    // Expected object captured by parsing this input on main with zod 3.25.76.
    const expected = {
      version: "1",
      name: "Agent A",
      description: "Fixture agent",
      identity: {
        default_name: "Agent A",
        emoji: "📋",
        personality: "Professional and helpful.",
        communication_style: "Clear and direct.",
      },
      flair: [],
      model: { default: "reasoning" },
      tools: { required: [], optional: [] },
      communication: { channels: ["direct"], handoff_targets: [] },
      boundaries: { can_commit: false, can_send_external: false, can_spend: false },
      memory: { private: true, shared_read: [], shared_write: [] },
      openclaw: {
        model: "anthropic/claude-sonnet-4-20250514",
        thinking: "off",
        channel: "discord",
      },
    };

    const result = TPSReportSchema.safeParse({
      name: "Agent A",
      description: "Fixture agent",
      identity: { default_name: "Agent A" },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(expected);
  });

  // Captured from zod 3.25.76 by parsing each value through
  // z.string({ required_error: "I'm gonna need you to put a name on that TPS report." }).
  // getParsedType's "unknown" arm is unreachable: typeof does not produce it.
  const zod3ReceivedMessages: Record<string, string> = {
    undefined: "I'm gonna need you to put a name on that TPS report.",
    nan: "Expected string, received nan",
    number: "Expected string, received number",
    boolean: "Expected string, received boolean",
    function: "Expected string, received function",
    bigint: "Expected string, received bigint",
    symbol: "Expected string, received symbol",
    array: "Expected string, received array",
    null: "Expected string, received null",
    promise: "Expected string, received promise",
    map: "Expected string, received map",
    set: "Expected string, received set",
    date: "Expected string, received date",
    object: "Expected string, received object",
  };
  const zod3Samples: Record<string, unknown> = {
    undefined,
    nan: Number.NaN,
    number: 42,
    boolean: true,
    function: function fixture() {},
    bigint: 1n,
    symbol: Symbol("fixture"),
    array: [],
    null: null,
    promise: Promise.resolve(),
    map: new Map(),
    set: new Set(),
    date: new Date(),
    object: {},
  };

  for (const [parsedType, value] of Object.entries(zod3Samples)) {
    test(`reports "${parsedType}" for a ${parsedType} value`, () => {
      const result = TPSReportSchema.safeParse({
        name: value,
        description: "Fixture agent",
        identity: { default_name: "Agent A" },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((candidate) => candidate.path.join(".") === "name");
        expect(issue?.message).toBe(zod3ReceivedMessages[parsedType]);
      }
    });
  }

  test("accepts a string in a string field", () => {
    expect(
      TPSReportSchema.safeParse({
        name: "Agent A",
        description: "Fixture agent",
        identity: { default_name: "Agent A" },
      }).success
    ).toBe(true);
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
