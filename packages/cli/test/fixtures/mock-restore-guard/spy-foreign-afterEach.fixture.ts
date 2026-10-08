// cli#555 red fixture: the teardown's afterEach is not the one from "bun:test".
// The guard must report this file (missing-mock-restore-teardown). Not named
// *.test.ts, so it is not automatically discovered.
import { expect, mock, spyOn, test } from "bun:test";
import { afterEach } from "./not-bun-test.js";

class Transport {
  async connect(): Promise<void> {}
}

afterEach(() => {
  mock.restore();
});

test("replaces a prototype method", () => {
  spyOn(Transport.prototype, "connect").mockResolvedValue(undefined);
  expect(Transport.prototype.connect).toBeDefined();
});
