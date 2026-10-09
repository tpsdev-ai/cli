// cli#555 red fixture: inside an outer describe, the mock.restore() teardown
// sits in a sibling describe of the one that registers the spy. The guard must
// report this file (missing-mock-restore-teardown). Not named *.test.ts, so it
// is not automatically discovered.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

describe("outer", () => {
  describe("registers a spy", () => {
    test("replaces a prototype method", () => {
      spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
      expect(Transport.prototype.connect).toBeDefined();
    });
  });

  describe("some other area", () => {
    afterEach(() => {
      mock.restore();
    });
  });
});
