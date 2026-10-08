// cli#555 red fixture: two spies, only one restored in the teardown. The other
// leaks, so the guard must report this file (spy-not-restored-in-teardown). Not
// named *.test.ts, so it is not automatically discovered.
import { afterEach, expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
  async send(): Promise<void> {}
}

const first = spyOn(Transport.prototype, "connect");

afterEach(() => {
  first.mockRestore();
});

test("registers two spies and restores one", () => {
  spyOn(Transport.prototype, "send").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
