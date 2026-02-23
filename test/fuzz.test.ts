import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { TPSReportSchema } from "../src/schema/report.js";
import { parseJoinToken } from "../src/commands/office.js";
import { sanitizeIdentifier, sanitizeFreeText } from "../src/schema/sanitizer.js";
import { decodeWireMessage, extractWireFrames } from "../src/utils/wire-frame.js";
import yaml from "js-yaml";

describe("Fuzz Testing (Property-Based)", () => {
  test("sanitizeIdentifier should never return a string with invalid characters", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const sanitized = sanitizeIdentifier(input);
        expect(sanitized).toMatch(/^[a-zA-Z0-9_-]*$/);
      })
    );
  });

  test("sanitizeFreeText should never return a string with unescaped shell metacharacters", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const sanitized = sanitizeFreeText(input);
        // Ensure that shell metacharacters are either preceded by a backslash or not present
        // This is a simplified check for common shell injection characters
        expect(sanitized).not.toMatch(/(?<!\\)[$&\`|;<>]/); 
      })
    );
  });

  test("parseJoinToken should not crash the process on random strings (should throw cleanly)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          parseJoinToken(input);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      })
    );
  });
  
  test("TPSReportSchema.safeParse should handle arbitrary YAML objects safely without crashing", () => {
    fc.assert(
      fc.property(fc.object(), (inputObj) => {
        try {
          const yamlStr = yaml.dump(inputObj);
          TPSReportSchema.safeParse(yaml.load(yamlStr));
        } catch (e) {
          // It's allowed to throw (e.g. stringify issues), but shouldn't crash process
          expect(e).toBeDefined();
        }
      })
    );
  });

  test("decodeWireMessage & extractWireFrames should not crash on malformed buffers", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (inputArray) => {
        const buf = Buffer.from(inputArray);
        try {
          // This should either parse valid frames, return empty/partial, or throw cleanly
          const { messages } = extractWireFrames(buf);
          for (const msg of messages) {
            decodeWireMessage(msg);
          }
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      })
    );
  });
});
