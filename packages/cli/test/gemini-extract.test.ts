import { expect, test, describe } from "bun:test";
import { extractFinalAnswer } from "../src/utils/gemini-runtime.js";

describe("extractFinalAnswer", () => {
  test("strips YOLO preamble lines", () => {
    const raw = `YOLO mode is enabled. All tool calls will be automatically approved.
Loaded cached credentials.

I'll review the PR now.

The PR looks good. Changes are secure.`;
    const result = extractFinalAnswer(raw);
    expect(result).not.toContain("YOLO mode");
    expect(result).toContain("The PR looks good");
  });

  test("returns last paragraph(s) as final answer", () => {
    const raw = `YOLO mode is enabled. All tool calls will be automatically approved.

I'll analyze the code.

I've completed the analysis.

**Summary:** The changes are correct and secure. No issues found.`;
    const result = extractFinalAnswer(raw);
    expect(result).toContain("Summary");
    expect(result).not.toContain("YOLO");
  });

  test("handles empty input", () => {
    expect(extractFinalAnswer("")).toBe("");
  });

  test("strips ANSI color codes", () => {
    const raw = "\x1b[32mGreen text\x1b[0m\n\nFinal answer.";
    const result = extractFinalAnswer(raw);
    expect(result).not.toContain("\x1b");
    expect(result).toContain("Final answer");
  });
});
