// cli#555 red fixture: a spy on a shared prototype that no teardown restores.
// The guard must report this file (spy-not-restored-in-teardown). The name ends
// in .fixture.ts, not .test.ts, so bun never discovers or runs it.
import { expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

test("replaces a prototype method", () => {
  spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
