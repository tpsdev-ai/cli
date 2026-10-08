// cli#555 red fixture: the restores sit in a function that is never called. The
// guard must report this file (missing-mock-restore-teardown). Not named
// *.test.ts, so it is not automatically discovered.
import { afterEach, expect, mock, spyOn, test } from "bun:test";

class Transport {
  async connect(): Promise<void> {}
}

const spied = spyOn(Transport.prototype, "connect");

function unused(): void {
  spied.mockRestore();
  afterEach(() => {
    mock.restore();
  });
}
void unused;

test("replaces a prototype method", () => {
  expect(Transport.prototype.connect).toBeDefined();
});
