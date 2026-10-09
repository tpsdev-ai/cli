// cli#555 red fixture: a mock() function and no teardown. The guard must report
// this file (missing-mock-restore-teardown). Not named *.test.ts, so it is not
// automatically discovered.
import { expect, mock, test } from "bun:test";

test("calls a mock function", () => {
  const fn = mock(() => 1);
  expect(fn()).toBe(1);
});
