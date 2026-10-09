// cli#568 red fixture for the guarded-global preload: global-leak-guard.test.ts
// runs it as a *.test.ts file in a child bun with the preload. It writes a
// well-known global and never puts it back, so the run must fail naming
// globalThis.fetch.
import { expect, test } from "bun:test";

test("reads back the fetch it replaced", async () => {
  globalThis.fetch = (async () => new Response("fixture")) as typeof globalThis.fetch;
  const response = await fetch("https://example.invalid/");
  expect(await response.text()).toBe("fixture");
});
