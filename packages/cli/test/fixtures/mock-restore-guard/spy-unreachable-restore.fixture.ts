// cli#555 red fixture: the mock.restore() teardown is registered only under
// if (false), so it never runs. The guard must report this file
// (missing-mock-restore-teardown). Not named *.test.ts, so it is not
// automatically discovered.
import { afterEach, expect, mock, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

if (false) afterEach(() => mock.restore());

test("replaces a prototype method", () => {
  spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
