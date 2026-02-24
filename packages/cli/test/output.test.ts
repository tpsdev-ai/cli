import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { randomQuip, formatBytes, resolveReportPath } from "../src/utils/output.js";

describe("randomQuip", () => {
  test("returns a string for each category", () => {
    for (const cat of ["success", "error", "empty"] as const) {
      const quip = randomQuip(cat);
      expect(typeof quip).toBe("string");
      expect(quip.length).toBeGreaterThan(0);
    }
  });
});

describe("formatBytes", () => {
  test("formats small sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0b");
    expect(formatBytes(500)).toBe("500b");
    expect(formatBytes(1023)).toBe("1023b");
  });

  test("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0kb");
    expect(formatBytes(2048)).toBe("2.0kb");
    expect(formatBytes(1536)).toBe("1.5kb");
  });
});

describe("resolveReportPath", () => {
  test("resolves built-in personas", () => {
    const personas = ["developer", "designer", "support", "ea", "ops", "strategy"];
    for (const p of personas) {
      const resolved = resolveReportPath(p);
      expect(resolved).toContain(`${p}.tps`);
    }
  });

  test("rejects unknown persona name", () => {
    expect(() => resolveReportPath("nonexistent-persona")).toThrow(/not a file path|not.*known/i);
  });

  test("resolves direct file path", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "valid-minimal.tps");
    const resolved = resolveReportPath(fixturePath);
    expect(resolved).toBe(fixturePath);
  });

  test("throws for nonexistent file path", () => {
    expect(() => resolveReportPath("/tmp/nope.tps")).toThrow(/read|file/i);
  });
});
