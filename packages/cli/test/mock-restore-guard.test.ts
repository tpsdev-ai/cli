/**
 * mock-restore-guard.test.ts — cli#555.
 *
 * Every cli test file runs in ONE bun process with every other file, so a spy
 * (`spyOn`) a file leaves in place changes what a later file observes: cli#544's
 * `WsNoiseTransport.prototype.connect` spy made two transport tests time out only
 * in suite order, while passing when run alone. `mock.module` is the same kind of
 * shared-state change, with a worse property: mock.restore() does not undo it (see
 * the probe below), so a shared-process file that registers one cannot clean up.
 *
 * This guard reads each cli test file's SOURCE (see
 * helpers/mock-restore-guard-scan.ts) and fails when a file
 *   - calls `mock.module(...)`, or
 *   - registers a `spyOn(...)` that no reachable restore covering its scope
 *     undoes, or
 *   - assigns a `process.env` name in a `beforeEach` / `beforeAll` hook that no
 *     teardown restores.
 *
 * Fixture files under fixtures/mock-restore-guard/ pin the scanner's verdict on
 * its own: red fixtures (a leaked prototype spy, a leaked env name, an unreachable
 * restore, …) must be reported, green fixtures (a restored prototype spy, a
 * recognised env save/restore) must be clean.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Finding, analyzeSource, discoverCliTestFiles } from "./helpers/mock-restore-guard-scan.js";

const TEST_ROOT = import.meta.dir;
const FIXTURES = join(TEST_ROOT, "fixtures", "mock-restore-guard");

function findingsFor(file: string): Finding[] {
  return analyzeSource(readFileSync(file, "utf8"));
}

function kindsFor(file: string): string[] {
  return findingsFor(file).map((finding) => finding.kind);
}

function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe("mock restore guard (cli#555)", () => {
  test("no discovered cli test file leaves a spy, module mock or env name unrestored", () => {
    const offenders = discoverCliTestFiles(TEST_ROOT)
      .map((file) => ({ file, findings: analyzeSource(readFileSync(file, "utf8")) }))
      .filter((entry) => entry.findings.length > 0)
      .map((entry) => `${relative(TEST_ROOT, entry.file)}: ${JSON.stringify(entry.findings)}`);
    expect(offenders).toEqual([]);
  });

  test("reports a prototype spy that no teardown restores (red fixture)", () => {
    expect(kindsFor(fixture("prototype-spy-leaked.fixture.ts"))).toContain("spy-not-restored-in-teardown");
  });

  test("clears the same prototype spy once a teardown restores it (green fixture)", () => {
    expect(findingsFor(fixture("prototype-spy-restored.fixture.ts"))).toEqual([]);
  });

  test("reports process-wide env set in a before hook and never undone (red fixture)", () => {
    expect(kindsFor(fixture("env-leaked.fixture.ts"))).toContain("env-not-restored-in-teardown");
  });

  test("rejects a shared-process file that calls mock.module() (red fixture)", () => {
    expect(kindsFor(fixture("module-mock.fixture.ts"))).toContain("module-mock-needs-child-process");
  });

  test("mock.restore() does not undo mock.module(): a later consumer still receives the replacement", () => {
    const probe = spawnSync(process.execPath, ["test", "./module-mock-probe.ts"], {
      cwd: FIXTURES,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toContain("FIRST=MOCKED");
    expect(probe.stdout).toContain("SECOND=MOCKED");
  });

  test("reports two spies when the teardown restores only one (red fixture)", () => {
    expect(kindsFor(fixture("spy-partial-restore.fixture.ts"))).toContain("spy-not-restored-in-teardown");
  });

  test("reports a spy whose restore sits in a sibling describe (red fixture)", () => {
    expect(kindsFor(fixture("spy-sibling-restore.fixture.ts"))).toContain("spy-not-restored-in-teardown");
  });

  test("reports a spy whose only restore is inside if (false) (red fixture)", () => {
    expect(kindsFor(fixture("spy-unreachable-restore.fixture.ts"))).toContain("spy-not-restored-in-teardown");
  });

  test("reports a dynamic process.env read that restores nothing (red fixture)", () => {
    expect(kindsFor(fixture("env-read.fixture.ts"))).toContain("env-not-restored-in-teardown");
  });

  test("reports an unrelated-key delete that restores nothing (red fixture)", () => {
    expect(kindsFor(fixture("env-unrelated-delete.fixture.ts"))).toContain("env-not-restored-in-teardown");
  });

  test("clears a save/restore of a name that held a value before the run (green fixture)", () => {
    expect(findingsFor(fixture("env-restored-present.fixture.ts"))).toEqual([]);
  });

  test("clears a save/restore that removes a name absent before the run (green fixture)", () => {
    expect(findingsFor(fixture("env-restored-absent.fixture.ts"))).toEqual([]);
  });

  test("the recognised save/restore puts a present key back and removes an absent one (real process.env)", () => {
    const present = "TPS_GUARD_PRESENT_KEY";
    const absent = "TPS_GUARD_ABSENT_KEY";
    process.env[present] = "original";
    delete process.env[absent];
    const saved = { [present]: process.env[present], [absent]: process.env[absent] };
    process.env[present] = "changed";
    process.env[absent] = "created";
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    expect(process.env[present]).toBe("original");
    expect(absent in process.env).toBe(false);
    delete process.env[present];
  });
});
