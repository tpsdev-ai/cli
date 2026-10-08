// cli#555 green fixture: a process.env name set in a before* hook and removed
// again by a recognised save/restore at teardown. The name was absent before the
// run, so the restore deletes it. The guard must report nothing. Not named
// *.test.ts, so it is not automatically discovered.
import { afterEach, beforeEach, expect, test } from "bun:test";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ["TPS_FIXTURE_ABSENT"]) saved[key] = process.env[key];
  process.env.TPS_FIXTURE_ABSENT = "fixture";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_ABSENT).toBe("fixture");
});
