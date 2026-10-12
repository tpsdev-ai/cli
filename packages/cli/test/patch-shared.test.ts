import { afterAll, describe, expect, test } from "bun:test";
import { PatchAfterCleanupError, createPatchRegistry, createPatchShared } from "./helpers/patch-shared.js";

const patch = createPatchShared();

test("removes a fresh global property on restore", () => {
  const property = "__tpsPatchSharedFreshGlobal";
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  expect(property in target).toBe(false);
  const restore = patch(target, property, "patched");
  expect(target[property]).toBe("patched");
  restore();
  expect(property in target).toBe(false);
  expect(Object.hasOwn(target, property)).toBe(false);
});

test("removes a new plain-object property on restore", () => {
  const target: { value?: string } = {};
  const restore = patch(target, "value", "patched");
  expect(target.value).toBe("patched");
  restore();
  expect("value" in target).toBe(false);
  expect(Object.hasOwn(target, "value")).toBe(false);
});

test("restores an accessor descriptor without calling its getter or setter", () => {
  let reads = 0;
  let writes = 0;
  const target = Object.defineProperty({} as { value: string }, "value", {
    configurable: true,
    enumerable: false,
    get: () => { reads++; return "original"; },
    set: () => { writes++; },
  });
  const original = Object.getOwnPropertyDescriptor(target, "value");
  const restore = patch(target, "value", "patched");
  expect(target.value).toBe("patched");
  restore();
  expect(Object.getOwnPropertyDescriptor(target, "value")).toEqual(original);
  expect(reads).toBe(0);
  expect(writes).toBe(0);
});

test("restores a non-writable descriptor", () => {
  const target = Object.defineProperty({} as { value: string }, "value", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: "original",
  });
  const original = Object.getOwnPropertyDescriptor(target, "value");
  const restore = patch(target, "value", "patched");
  expect(target.value).toBe("patched");
  restore();
  expect(Object.getOwnPropertyDescriptor(target, "value")).toEqual(original);
});

test("unwinds nested patches to an absent property", () => {
  const target: { value?: string } = {};
  const restore = patch(target, "value", "first");
  const restoreSecond = patch(target, "value", "second");
  restore();
  expect(Object.hasOwn(target, "value")).toBe(false);
  restoreSecond();
  expect(Object.hasOwn(target, "value")).toBe(false);
});

describe("patch factory refuses a patch after its cleanup ran (cli#603)", () => {
  test("restores patches made before cleanup, then refuses a later patch", () => {
    let cleanup: (() => void) | undefined;
    const registry = createPatchRegistry((hook) => { cleanup = hook; });
    const target: Record<string, number> = { m: 1 };

    registry(target, "m", 2);
    expect(target.m).toBe(2);
    expect(typeof cleanup).toBe("function");

    cleanup!();
    expect(target.m).toBe(1);

    expect(() => registry(target, "m", 3)).toThrow(PatchAfterCleanupError);
    expect(() => registry(target, "m", 3)).toThrow("a patch cannot outlive cleanup");
  });

  test("names the refusal", () => {
    let cleanup: (() => void) | undefined;
    const registry = createPatchRegistry((hook) => { cleanup = hook; });
    cleanup!();
    const refusal = (() => {
      try {
        registry({} as Record<string, number>, "m", 1);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(PatchAfterCleanupError);
    expect((refusal as Error).name).toBe("PatchAfterCleanupError");
  });
});

// The real factory driven through bun's own afterAll: the factory registers its
// cleanup when this line runs, and the hook below registers after it, so bun —
// which runs afterAll hooks in registration order — has cleaned up by the time
// it runs. A patch requested then must be refused.
const realPatch = createPatchShared();
afterAll(() => {
  expect(() => realPatch({} as Record<string, number>, "m", 1)).toThrow(PatchAfterCleanupError);
});
