// cli#555 red fixture: a before* hook sets a process.env name and the teardown
// merely READS process.env dynamically; it restores nothing. The guard must
// report this file (env-not-restored-in-teardown). Not named *.test.ts, so it is
// not automatically discovered.
import { afterEach, beforeEach, expect, test } from "bun:test";

const someKey = "TPS_FIXTURE_VALUE";

beforeEach(() => {
  process.env.TPS_FIXTURE_VALUE = "fixture";
});

afterEach(() => {
  void process.env[someKey];
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_VALUE).toBe("fixture");
});
