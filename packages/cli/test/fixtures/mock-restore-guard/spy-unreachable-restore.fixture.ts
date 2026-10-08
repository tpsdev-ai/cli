// cli#555 red fixture: the spy's only restore is inside `if (false)`, so it
// never runs. The guard must report this file (spy-not-restored-in-teardown).
// Not named *.test.ts, so it is not automatically discovered.
import { afterEach, expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

let spied: ReturnType<typeof spyOn>;

afterEach(() => {
  if (false) spied.mockRestore();
});

test("replaces a prototype method", () => {
  spied = spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
