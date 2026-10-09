// cli#568 green fixture for the guarded-global preload: global-leak-guard.test.ts
// runs it as a *.test.ts file in a child bun with the preload. It saves the
// original fetch and restores it in a top-level afterAll, so the run must pass.
import { afterAll, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("reads back the fetch it replaced", async () => {
  globalThis.fetch = (async () => new Response("fixture")) as typeof globalThis.fetch;
  const response = await fetch("https://example.invalid/");
  expect(await response.text()).toBe("fixture");
});
