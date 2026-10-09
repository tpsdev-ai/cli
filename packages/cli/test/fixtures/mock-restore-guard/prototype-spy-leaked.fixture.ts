// cli#555 red fixture: a spy on a shared prototype and no teardown. The guard
// must report this file (missing-mock-restore-teardown). The name ends in
// .fixture.ts, not .test.ts, so it is not automatically discovered.
import { expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

test("replaces a prototype method", () => {
  spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
