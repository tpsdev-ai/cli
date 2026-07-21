import { describe, test, expect } from "bun:test";
import { TpsYamlSchema } from "../src/schema/manifest.js";

describe("TpsYamlSchema", () => {
  test("validates minimal manifest", () => {
    const res = TpsYamlSchema.safeParse({ name: "agent-1" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.name).toBe("agent-1");
    }
  });

  test("applies defaults for mail_handler", () => {
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      capabilities: {
        mail_handler: {}
      }
    });
    expect(res.success).toBe(true);
    if (res.success) {
      const mh = res.data.capabilities?.mail_handler;
      expect(mh?.enabled).toBe(true);
      expect(mh?.priority).toBe(100);
      expect(mh?.timeout).toBe(30);
      expect(mh?.needs_roster).toBe(false);
    }
  });

  test("fails on missing name", () => {
    const res = TpsYamlSchema.safeParse({ version: "1.0.0" });
    expect(res.success).toBe(false);
  });

  test("fails on strict violations", () => {
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      unknown_field: "invalid"
    });
    expect(res.success).toBe(false);
  });

  test("validates routing rules", () => {
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      routing: [
        { pattern: ".*", to: "other-agent" }
      ]
    });
    expect(res.success).toBe(true);
  });

  test("accepts ordinary match and routing patterns", () => {
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      capabilities: {
        mail_handler: { match: { bodyPattern: "^deploy\\b.*(prod|staging)" } }
      },
      routing: [
        { pattern: "urgent|priority", to: "other-agent" },
        { pattern: "a{1,50}", to: "third-agent" }
      ]
    });
    expect(res.success).toBe(true);
  });

  test("rejects an unsafe routing pattern at schema validation", () => {
    // A pattern that compiles fine but whose match cost is not bounded by input
    // length must be refused before it can ever be handed to new RegExp().test().
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      routing: [
        { pattern: "(a+)+$", to: "other-agent" }
      ]
    });
    expect(res.success).toBe(false);
  });

  test("rejects an unsafe body match pattern at schema validation", () => {
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      capabilities: {
        mail_handler: { match: { bodyPattern: "([a-zA-Z]+)*$" } }
      }
    });
    expect(res.success).toBe(false);
  });

  test("pattern validation is bounded — settles quickly", () => {
    // Before schema-time validation, such a pattern would be accepted and only
    // exercised much later during matching. Validation must settle well under a
    // small time bound rather than getting stuck evaluating the pattern.
    const start = Date.now();
    const res = TpsYamlSchema.safeParse({
      name: "agent-1",
      routing: [
        { pattern: "(.*a){25}", to: "other-agent" }
      ]
    });
    const elapsedMs = Date.now() - start;
    expect(res.success).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });
});
