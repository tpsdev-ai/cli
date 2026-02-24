import { describe, test, expect } from "bun:test";
import { LoopDetector } from "../src/utils/loop-detector.js";

describe("loop-detector", () => {
  test("allows messages below threshold", () => {
    const ld = new LoopDetector({ threshold: 3 });
    expect(ld.check("hello")).toBe(false);
    expect(ld.check("hello")).toBe(false);
  });

  test("triggers at threshold", () => {
    const ld = new LoopDetector({ threshold: 3 });
    ld.check("hello");
    ld.check("hello");
    expect(ld.check("hello")).toBe(true);
  });

  test("different messages don't trigger", () => {
    const ld = new LoopDetector({ threshold: 3 });
    expect(ld.check("a")).toBe(false);
    expect(ld.check("b")).toBe(false);
    expect(ld.check("c")).toBe(false);
  });

  test("prunes old entries outside window", () => {
    const ld = new LoopDetector({ threshold: 3, windowMs: 100 });
    ld.check("hello");
    ld.check("hello");
    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 150) {
      // busy wait
    }
    expect(ld.check("hello")).toBe(false); // old entries pruned
  });

  test("reset clears history", () => {
    const ld = new LoopDetector({ threshold: 2 });
    ld.check("hello");
    ld.reset();
    expect(ld.check("hello")).toBe(false);
  });

  test("duplicateCount returns current count", () => {
    const ld = new LoopDetector({ threshold: 5 });
    ld.check("hello");
    ld.check("hello");
    expect(ld.duplicateCount("hello")).toBe(2);
  });
});
