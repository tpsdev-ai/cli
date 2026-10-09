// cli#568 green fixture for the guarded-global preload: global-leak-guard.test.ts
// runs it as a *.test.ts file in a child bun with the preload, beside a copy of
// patch-shared.ts. It patches fetch through the patchShared helper, which
// restores the original in a top-level afterAll, so the run must pass.
import { expect, test } from "bun:test";
import { patchShared } from "./patch-shared.js";

patchShared(globalThis, "fetch", (async () => new Response("fixture")) as typeof globalThis.fetch);

test("reads back the fetch patchShared installed", async () => {
  const response = await fetch("https://example.invalid/");
  expect(await response.text()).toBe("fixture");
});
