// cli#555 green fixture for the env leak preload: env-leak-guard.test.ts runs it
// as a *.test.ts file in a child bun with the preload,
// TPS_FIXTURE_PRESENT=original and TPS_FIXTURE_ABSENT unset. It saves both
// names before setting them and restores them, so the run must pass.
import { afterEach, beforeEach, expect, test } from "bun:test";

const NAMES = ["TPS_FIXTURE_PRESENT", "TPS_FIXTURE_ABSENT"];
const incoming = { present: process.env.TPS_FIXTURE_PRESENT, absent: Object.hasOwn(process.env, "TPS_FIXTURE_ABSENT") };
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of NAMES) saved[key] = process.env[key];
  process.env.TPS_FIXTURE_PRESENT = "fixture";
  process.env.TPS_FIXTURE_ABSENT = "fixture";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("started with TPS_FIXTURE_PRESENT=original and TPS_FIXTURE_ABSENT unset", () => {
  expect(incoming).toEqual({ present: "original", absent: false });
});

test("reads the values it set", () => {
  expect(process.env.TPS_FIXTURE_PRESENT).toBe("fixture");
  expect(process.env.TPS_FIXTURE_ABSENT).toBe("fixture");
});
