import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPatchShared } from "./patch-shared.js";
const patchShared = createPatchShared();
const originalFetch = globalThis.fetch;
const handles = { value: originalFetch };

beforeEach(() => {
  const replacement = (async () => new Response("fixture")) as typeof fetch;
  patchShared(handles, "value", replacement);
  patchShared(globalThis, "fetch", replacement);
});
afterEach(() => {
  expect(globalThis.fetch).toBe(handles.value);
});
for (const name of ["first", "second"]) {
  test(name, async () => { expect(await (await fetch("https://example.invalid/")).text()).toBe("fixture"); });
}
