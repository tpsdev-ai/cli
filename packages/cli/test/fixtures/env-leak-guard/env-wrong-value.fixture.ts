// cli#555 red fixture for the env leak preload: env-leak-guard.test.ts runs it
// as a *.test.ts file in a child bun with the preload and
// TPS_FIXTURE_PRESENT=original. Its restore assigns a value other than the
// saved one, so the run must fail naming TPS_FIXTURE_PRESENT.
import { afterEach, beforeEach, expect, test } from "bun:test";

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = { TPS_FIXTURE_PRESENT: process.env.TPS_FIXTURE_PRESENT };
  process.env.TPS_FIXTURE_PRESENT = "fixture";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = "wrong";
  }
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_PRESENT).toBe("fixture");
});
