// cli#555 red fixture: the spy's restore sits in a sibling describe, so it does
// not run for the describe that registered the spy. The guard must report this
// file (missing-mock-restore-teardown). Not named *.test.ts, so it is not
// automatically discovered.
import { afterEach, describe, expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

let spied: ReturnType<typeof spyOn>;

describe("registers a spy", () => {
  test("replaces a prototype method", () => {
    spied = spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
    expect(Transport.prototype.connect).toBeDefined();
  });
});

describe("some other area", () => {
  afterEach(() => {
    spied.mockRestore();
  });
});
