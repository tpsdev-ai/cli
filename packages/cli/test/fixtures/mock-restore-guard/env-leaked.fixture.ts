// cli#555 red fixture: process-wide state set in a before* hook and never undone
// by a teardown. The guard must report this file
// (env-not-restored-in-teardown). Not named *.test.ts, so bun never runs it.
import { beforeEach, expect, test } from "bun:test";

beforeEach(() => {
  process.env.TPS_FIXTURE_VALUE = "fixture";
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_VALUE).toBe("fixture");
});
