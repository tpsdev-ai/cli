// cli#555 red fixture for the env leak preload: env-leak-guard.test.ts runs it
// as a *.test.ts file in a child bun with the preload. It sets a name and never
// restores it, so the run must fail naming TPS_FIXTURE_VALUE.
import { beforeEach, expect, test } from "bun:test";

beforeEach(() => {
  process.env.TPS_FIXTURE_VALUE = "fixture";
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_VALUE).toBe("fixture");
});
