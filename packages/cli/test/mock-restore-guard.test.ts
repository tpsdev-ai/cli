/**
 * mock-restore-guard.test.ts — cli#555.
 *
 * Every cli test file runs in ONE bun process with every other file, so a spy
 * (`spyOn`) or a module mock (`mock.module`) a file leaves in place changes what
 * a later file observes, and so does a `process.env` value a before* hook sets
 * and never puts back. cli#544 hit the spy case: a
 * `WsNoiseTransport.prototype.connect` spy left unrestored made two transport
 * tests time out only in suite order, while passing when run alone.
 *
 * This guard reads each cli test file's SOURCE (see
 * helpers/mock-restore-guard-scan.ts) and fails when a file
 *   - registers a spy or a module mock without a `mock.restore()` /
 *     `.mockRestore()` in an `afterEach` / `afterAll` hook, or
 *   - assigns a `process.env` variable in a `beforeEach` / `beforeAll` hook that
 *     no teardown restores.
 *
 * Three fixture files under fixtures/mock-restore-guard/ pin the scanner's
 * verdict on its own: one leaks a prototype spy and one leaks process state (both
 * must be reported), one restores its prototype spy (must be clean).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Finding, analyzeSource, discoverCliTestFiles } from "./helpers/mock-restore-guard-scan.js";

const TEST_ROOT = import.meta.dir;
const FIXTURES = join(TEST_ROOT, "fixtures", "mock-restore-guard");

function findingsFor(file: string): Finding[] {
  return analyzeSource(readFileSync(file, "utf8"));
}

describe("mock restore guard (cli#555)", () => {
  test("no cli test file registers a spy or module mock without restoring it in a teardown", () => {
    const offenders = discoverCliTestFiles(TEST_ROOT)
      .map((file) => ({ file, findings: analyzeSource(readFileSync(file, "utf8")) }))
      .filter((entry) => entry.findings.length > 0)
      .map((entry) => `${relative(TEST_ROOT, entry.file)}: ${JSON.stringify(entry.findings)}`);
    expect(offenders).toEqual([]);
  });

  test("reports a prototype spy that no teardown restores (red fixture)", () => {
    expect(findingsFor(join(FIXTURES, "prototype-spy-leaked.fixture.ts")).map((f) => f.kind)).toContain(
      "spy-not-restored-in-teardown",
    );
  });

  test("clears the same prototype spy once a teardown restores it (green fixture)", () => {
    expect(findingsFor(join(FIXTURES, "prototype-spy-restored.fixture.ts"))).toEqual([]);
  });

  test("reports process-wide env set in a before hook and never undone (red fixture)", () => {
    expect(findingsFor(join(FIXTURES, "env-leaked.fixture.ts")).map((f) => f.kind)).toContain(
      "env-not-restored-in-teardown",
    );
  });
});
