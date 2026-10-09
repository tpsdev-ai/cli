import { expect, test } from "bun:test";
import { patchShared } from "./patch-shared.js";

patchShared(globalThis, "fetch", (async () => new Response("first")) as typeof globalThis.fetch);
patchShared(globalThis, "fetch", (async () => new Response("fixture")) as typeof globalThis.fetch);

test("reads back the fetch patchShared installed", async () => {
  const response = await fetch("https://example.invalid/");
  expect(await response.text()).toBe("fixture");
});
