// cli#555 green fixture: a process.env name set in a before* hook and put back
// by a recognised save/restore at teardown. The name held a value before the
// run, so the restore assigns the saved value back. The guard must report
// nothing. Not named *.test.ts, so it is not automatically discovered.
import { afterEach, beforeEach, expect, test } from "bun:test";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { TPS_FIXTURE_PRESENT: process.env.TPS_FIXTURE_PRESENT };
  process.env.TPS_FIXTURE_PRESENT = "fixture";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("reads the value it set", () => {
  expect(process.env.TPS_FIXTURE_PRESENT).toBe("fixture");
});
