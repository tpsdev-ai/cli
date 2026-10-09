/**
 * mock-restore-guard.test.ts — cli#555.
 *
 * Every cli test file runs in ONE bun process with every other file, so a spy
 * (`spyOn`) a file leaves in place changes what a later file observes: cli#544's
 * `WsNoiseTransport.prototype.connect` spy made two transport tests time out only
 * in suite order, while passing when run alone. `mock.module` is the same kind of
 * shared-state change, but mock.restore() does not undo it (see the probe below).
 *
 * This guard parses each discovered cli test file (see
 * helpers/mock-restore-guard-scan.ts) and fails when a file
 *   - calls `mock.module(...)`.
 *
 * Fixture files under fixtures/mock-restore-guard/ pin the verdicts: each red
 * fixture must be reported, each green fixture must be clean. process.env is
 * checked at run time by helpers/env-leak-preload.ts (env-leak-guard.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Finding, analyzeSource, discoverCliTestFiles } from "./helpers/mock-restore-guard-scan.js";

const TEST_ROOT = import.meta.dir;
const FIXTURES = join(TEST_ROOT, "fixtures", "mock-restore-guard");

function findingsFor(name: string): Finding[] {
  return analyzeSource(readFileSync(join(FIXTURES, name), "utf8"));
}

function kindsFor(name: string): string[] {
  return findingsFor(name).map((finding) => finding.kind);
}

describe("mock restore guard (cli#555)", () => {
  test("discovered cli test files: no mock.module() call, and the mock.restore() teardown wherever the check requires it", () => {
    const offenders = discoverCliTestFiles(TEST_ROOT)
      .map((file) => ({ file, findings: analyzeSource(readFileSync(file, "utf8")) }))
      .filter((entry) => entry.findings.length > 0)
      .map((entry) => `${relative(TEST_ROOT, entry.file)}: ${JSON.stringify(entry.findings)}`);
    expect(offenders).toEqual([]);
  });

  for (const name of [
    "prototype-spy-leaked.fixture.ts",
    "spy-partial-restore.fixture.ts",
    "spy-sibling-restore.fixture.ts",
    "spy-nested-sibling-restore.fixture.ts",
    "spy-uncalled-cleanup.fixture.ts",
    "spy-reused-binding.fixture.ts",
    "spy-unreachable-restore.fixture.ts",
    "spy-foreign-afterEach.fixture.ts",
    "mock-fn-leaked.fixture.ts",
    "spy-aliased-leaked.fixture.ts",
  ]) {
    test(`reports ${name} (red fixture)`, () => {
      expect(kindsFor(name)).toContain("missing-mock-restore-teardown");
    });
  }

  for (const name of [
    "prototype-spy-restored.fixture.ts",
    "spy-restored-expression.fixture.ts",
    "spy-aliased-restored.fixture.ts",
    "spy-namespace-restored.fixture.ts",
  ]) {
    test(`clears ${name} (green fixture)`, () => {
      expect(findingsFor(name)).toEqual([]);
    });
  }

  test("rejects a shared-process file that calls mock.module() (red fixture)", () => {
    expect(kindsFor("module-mock.fixture.ts")).toContain("module-mock-needs-child-process");
  });

  for (const name of ["module-mock-aliased.fixture.ts", "module-mock-namespace.fixture.ts"]) {
    test(`reports ${name} (red fixture)`, () => {
      expect(kindsFor(name)).toContain("module-mock-needs-child-process");
    });
  }

  for (const api of ["mock", "spyOn", "jest", "vi"]) {
    test(`reports aliased ${api} usage without teardown`, () => {
      expect(analyzeSource(`import { ${api} as local } from "bun:test"; local;`).map((finding) => finding.kind))
        .toContain("missing-mock-restore-teardown");
      expect(analyzeSource(`import * as bt from "bun:test"; bt.${api};`).map((finding) => finding.kind))
        .toContain("missing-mock-restore-teardown");
    });
  }

  for (const source of [
    'import bt from "bun:test"; bt.mock();',
    'import * as bt from "bun:test"; bt["mock"]();',
    'import * as bt from "bun:test"; const { mock: m } = bt; m();',
    'const bt = await import("bun:test"); bt.mock();',
    'const bt = require("bun:test"); bt.mock();',
    'import bt = require("bun:test"); bt.mock();',
    'import { mock as m } from "bun:test"; m["module"]("target", () => ({}));',
    'import { mock as m } from "bun:test"; const alias = m; alias.module("target", () => ({}));',
    'import { mock as m } from "bun:test"; const register = m.module; register("target", () => ({}));',
  ]) {
    test(`reports unresolved bun:test access: ${source}`, () => {
      expect(analyzeSource(`import { afterEach, mock } from "bun:test"; afterEach(() => mock.restore()); ${source}`)
        .map((finding) => finding.kind)).toContain("missing-mock-restore-teardown");
    });
  }

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
});
