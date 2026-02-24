import { describe, test, expect } from "bun:test";
import {
  sanitizeIdentifier,
  sanitizeModelIdentifier,
  sanitizeFreeText,
  sanitizeTPSReport,
} from "../src/schema/sanitizer.js";
import { parseTPSReport } from "../src/schema/report.js";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("sanitizer", () => {
  test("sanitizeIdentifier strips invalid characters", () => {
    expect(sanitizeIdentifier("valid-id_123")).toBe("valid-id_123");
    expect(sanitizeIdentifier("invalid id!")).toBe("invalid-id");
    // path separators are stripped, not kept
    expect(sanitizeIdentifier("path/traversal/../")).toBe("path-traversal");
    expect(sanitizeIdentifier("")).toBe("unknown");
    expect(sanitizeIdentifier("-leading-trailing-")).toBe("leading-trailing");
    expect(sanitizeIdentifier("multi---dashes")).toBe("multi-dashes");
  });

  test("sanitizeModelIdentifier allows slash/colon/dot", () => {
    expect(sanitizeModelIdentifier("anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
    expect(sanitizeModelIdentifier("ollama/qwen:7b")).toBe("ollama/qwen:7b");
    expect(sanitizeModelIdentifier("google/gemini-1.5-pro")).toBe("google/gemini-1.5-pro");
    expect(sanitizeModelIdentifier("invalid model!")).toBe("invalidmodel"); // spaces removed
    expect(sanitizeModelIdentifier("")).toBe("unknown-model");
  });

  test("sanitizeFreeText escapes shell metacharacters", () => {
    expect(sanitizeFreeText("normal text")).toBe("normal text");
    expect(sanitizeFreeText("$(rm -rf /)")).toBe("\\$\\(rm -rf /\\)");
    expect(sanitizeFreeText("backtick `execution`")).toBe("backtick \\`execution\\`");
    expect(sanitizeFreeText('double "quotes"')).toBe('double \\"quotes\\"');
    expect(sanitizeFreeText("cmd1; cmd2")).toBe("cmd1\\; cmd2");
    expect(sanitizeFreeText("pipe | logical || and &&")).toBe("pipe \\| logical \\|\\| and \\&\\&");
    // Ensure it doesn't break newlines/tabs (though shell might treat them as separators, here we focus on injection)
    expect(sanitizeFreeText("multi\nline")).toBe("multi\nline");
  });

  test("sanitizeTPSReport cleans all fields", () => {
    const raw = parseTPSReport(join(FIXTURES, "valid-minimal.tps"));
    // Mutate to add bad stuff
    const tainted = {
      ...raw,
      name: "Bad Name!",
      description: "Injection attempt $(echo pwned)",
      identity: {
        ...raw.identity,
        default_name: "../../bad-agent",
        personality: "I am `evil`",
        communication_style: "Normal",
      },
      flair: ["valid", "in/valid"],
      openclaw: {
        ...raw.openclaw,
        model: "provider/model; rm -rf /",
        channel: "discord | nc attacker.com",
      }
    };

    const clean = sanitizeTPSReport(tainted);

    expect(clean.name).toBe("Bad-Name");
    expect(clean.description).toBe("Injection attempt \\$\\(echo pwned\\)");
    expect(clean.identity.default_name).toBe("bad-agent"); // path separators stripped
    expect(clean.identity.personality).toBe("I am \\`evil\\`");
    expect(clean.flair).toEqual(["valid", "in-valid"]);
    // Model identifier allows / but not ; or space. They are stripped.
    expect(clean.openclaw.model).toBe("provider/modelrm-rf/"); 
    expect(clean.openclaw.channel).toBe("discord-nc-attacker-com"); // sanitized as identifier (dots repl with -)
  });
});
