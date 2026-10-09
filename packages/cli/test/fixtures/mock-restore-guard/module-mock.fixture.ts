// cli#555 red fixture: a shared-process test file that calls mock.module().
// mock.restore() does not undo a module mock (see module-mock-probe.ts), so the
// guard must report this file (module-mock-needs-child-process) even though a
// teardown calls mock.restore(). Not named *.test.ts, so it is not automatically
// discovered.
import { afterEach, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

test("registers a module mock", () => {
  mock.module("./some-module.js", () => ({ value: "mocked" }));
  expect(true).toBe(true);
});
