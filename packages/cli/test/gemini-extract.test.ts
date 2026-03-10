import { expect, test, describe } from "bun:test";
import { extractFinalAnswer, formatGeminiProcessError } from "../src/utils/gemini-runtime.js";

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

  test("short output — returns single final paragraph, skips narration", () => {
    const raw = `YOLO mode is enabled. All tool calls will be automatically approved.

I'll analyze the code.

I've completed the analysis.

**Summary:** The changes are correct and secure. No issues found.`;
    const result = extractFinalAnswer(raw);
    expect(result).toContain("Summary");
    expect(result).not.toContain("I'll analyze");
    expect(result).not.toContain("I've completed");
  });

  test("long output (>5 paragraphs) — returns up to 3 concluding paragraphs", () => {
    const paragraphs = [
      "I'll start reviewing.",
      "Checking imports.",
      "Looking at the logic.",
      "Verifying tests.",
      "Reviewing security.",
      "All changes look correct.",
      "No vulnerabilities found.",
    ];
    const raw = paragraphs.join("\n\n");
    const result = extractFinalAnswer(raw);
    expect(result).toContain("No vulnerabilities found");
    expect(result).not.toContain("I'll start");
  });

  test("handles empty input", () => {
    expect(extractFinalAnswer("")).toBe("");
  });

  test("strips ANSI color codes", () => {
    const raw = "\u001b[32mGreen text\u001b[0m\n\nFinal answer.";
    const result = extractFinalAnswer(raw);
    expect(result).not.toContain("\u001b");
    expect(result).toContain("Final answer");
  });

  test("single paragraph — returns it regardless of narration prefix", () => {
    const raw = "I've completed the task successfully.";
    const result = extractFinalAnswer(raw);
    expect(result).toBe("I've completed the task successfully.");
  });
});

describe("formatGeminiProcessError", () => {
  test("formats hard timeout errors", () => {
    const error = formatGeminiProcessError(null, "", { timedOut: true, taskTimeoutMs: 1800000 });
    expect(error.message).toBe("timeout after 1800000ms");
  });

  test("formats watchdog stall errors", () => {
    const error = formatGeminiProcessError(null, "", { stalled: true, watchdogTimeoutMs: 300000 });
    expect(error.message).toBe("stalled: no gemini output for 300000ms");
  });

  test("includes stderr for abnormal exits", () => {
    const error = formatGeminiProcessError(1, "fatal: auth expired\n");
    expect(error.message).toBe("gemini exited 1: fatal: auth expired");
  });
});
