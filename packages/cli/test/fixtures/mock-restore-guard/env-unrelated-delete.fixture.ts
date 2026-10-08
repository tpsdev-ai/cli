// cli#555 red fixture: a before* hook sets a process.env name and the teardown
// deletes a DIFFERENT key dynamically; the set name is not restored. The guard
// must report this file (env-not-restored-in-teardown). Not named *.test.ts, so
// it is not automatically discovered.
import { afterEach, beforeEach, expect, test } from "bun:test";

const otherKey = "SOME_OTHER_KEY";

beforeEach(() => {
  process.env.TPS_FIXTURE_VALUE = "fixture";
});

afterEach(() => {
  delete process.env[otherKey];
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_VALUE).toBe("fixture");
});
