import { expect, test } from "bun:test";

test("replaces setImmediate", () => {
  const replacement = (() => undefined) as unknown as typeof setImmediate;
  globalThis.setImmediate = replacement;
  expect(globalThis.setImmediate).toBe(replacement);
});
