// cli#555 green fixture: the same prototype spy, with a teardown that restores
// it. The guard must report nothing for this file. Not named *.test.ts, so it is
// not automatically discovered.
import { afterEach, expect, mock, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

afterEach(() => {
  mock.restore();
});

test("replaces a prototype method and restores it", () => {
  spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
