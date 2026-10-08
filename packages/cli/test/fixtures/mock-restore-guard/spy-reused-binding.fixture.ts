// cli#555 red fixture: one binding holds two spies in turn, and the teardown
// restores only the later one. The guard must report this file
// (missing-mock-restore-teardown). Not named *.test.ts, so it is not
// automatically discovered.
import { afterEach, expect, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
  async send(): Promise<void> {}
}

let spied = spyOn(Transport.prototype, "connect");
spied = spyOn(Transport.prototype, "send");

afterEach(() => {
  spied.mockRestore();
});

test("replaces two prototype methods", () => {
  expect(Transport.prototype.connect).toBeDefined();
});
