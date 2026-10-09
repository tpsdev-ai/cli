// cli#555 red fixture for the env leak preload: env-leak-guard.test.ts runs it
// as a *.test.ts file in a child bun with the preload. Its only restore is under
// if (false), so the run must fail naming TPS_FIXTURE_VALUE.
import { afterEach, beforeEach, expect, test } from "bun:test";

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = { TPS_FIXTURE_VALUE: process.env.TPS_FIXTURE_VALUE };
  process.env.TPS_FIXTURE_VALUE = "fixture";
});

afterEach(() => {
  if (false) {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_VALUE).toBe("fixture");
});
