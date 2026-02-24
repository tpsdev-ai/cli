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
});
