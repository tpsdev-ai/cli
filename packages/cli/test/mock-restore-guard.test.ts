/** Static guard fixtures and cli test-tree scan. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { guardedGlobalFiles } from "./helpers/global-leak-preload.js";
import { type Finding, analyzeSource, discoverCliTestFiles } from "./helpers/mock-restore-guard-scan.js";

const TEST_ROOT = import.meta.dir;
/** The cli package root: the directory bun runs the cli suite from, and so the root
 * whose test files a suite discovers. */
const CLI_ROOT = join(TEST_ROOT, "..");
const FIXTURES = join(TEST_ROOT, "fixtures", "mock-restore-guard");

function findingsFor(name: string): Finding[] {
  return analyzeSource(readFileSync(join(FIXTURES, name), "utf8"));
}

function kindsFor(name: string): string[] {
  return findingsFor(name).map((finding) => finding.kind);
}

function detailsFor(name: string): string[] {
  return findingsFor(name).map((finding) => finding.detail);
}

describe("mock restore guard (cli#555)", () => {
  test("discovered cli test files satisfy the static guard", () => {
    const offenders = discoverCliTestFiles(CLI_ROOT)
      .map((file) => ({ file, findings: analyzeSource(readFileSync(file, "utf8")) }))
      .filter((entry) => entry.findings.length > 0)
      .map((entry) => `${relative(CLI_ROOT, entry.file)}: ${JSON.stringify(entry.findings)}`);
    expect(offenders).toEqual([]);
  });

  test("the scan discovers the forms bun discovers, over the cli package", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli603-discovery-"));
    try {
      const write = (rel: string) => {
        const path = join(dir, rel);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "// fixture\n");
      };
      const discovered = [
        "a.test.ts", "b_test.ts", "c.spec.ts", "d_spec.js", "e.test.mts", "f.test.cts",
        "g.test.tsx", "h.test.mjs", "i.test.cjs", "j.test.jsx", "sub/i.test.js", "dist/j.test.js",
        ".dotfile.test.ts",
      ];
      const missed = ["foo.test.helper.ts", "foo-spec.ts", "plain.ts", "node_modules/k.test.ts", ".dotdir/l.test.ts"];
      for (const file of [...discovered, ...missed]) write(file);
      expect(discoverCliTestFiles(dir)).toEqual(discovered.map((file) => join(dir, file)).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every cli test file this run loaded through the guard is in the scanned set", () => {
    const scanned = new Set(discoverCliTestFiles(CLI_ROOT));
    const loaded = guardedGlobalFiles()
      .filter((path) => path.startsWith(`${CLI_ROOT}/`) && !path.includes("/node_modules/"));
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((path) => !scanned.has(path))).toEqual([]);
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
    "direct-global-leaked.fixture.ts",
    "direct-module-leaked.fixture.ts",
    "cast-member-leaked.fixture.ts",
    "nested-import-leaked.fixture.ts",
    "cast-global-leaked.fixture.ts",
    "bare-global-leaked.fixture.ts",
    "destructured-alias-leaked.fixture.ts",
    "object-destructured-alias-leaked.fixture.ts",
    "property-read-alias-leaked.fixture.ts",
    "module-alias-non-mock-leaked.fixture.ts",
    "shadow-in-other-scope-leaked.fixture.ts",
    "global-alias-leaked.fixture.ts",
    "process-alias-leaked.fixture.ts",
    "destructured-root-alias-leaked.fixture.ts",
    "module-alias-outer-scope-leaked.fixture.ts",
    "dynamic-import-module-patched.fixture.ts",
    "nested-destructured-module-patched.fixture.ts",
    "process-cast-non-env-leaked.fixture.ts",
  ]) {
    test(`reports ${name} (red fixture)`, () => {
      expect(kindsFor(name)).toContain("direct-assignment-needs-restore");
    });
  }

  test("reports call-rooted-global-leaked.fixture.ts (red fixture)", () => {
    expect(kindsFor("call-rooted-global-leaked.fixture.ts")).toContain("unclassified-assignment-target");
  });

  test("refuses inline fetch restoration", () => {
    expect(
      analyzeSource(`import { afterAll, test } from "bun:test";
const original = globalThis.fetch;
afterAll(() => { globalThis.fetch = original; });
test("x", () => { globalThis.fetch = (async () => new Response("")) as typeof globalThis.fetch; });`).map(finding => finding.kind),
    ).toContain("direct-assignment-needs-restore");
  });

  test("an assignment to a local object is not an assignment to a global or a module object", () => {
    expect(analyzeSource(`const local = { a: 1 };\nlocal.a = 2;`)).toEqual([]);
  });

  for (const name of [
    "prototype-spy-restored.fixture.ts",
    "spy-restored-expression.fixture.ts",
    "spy-aliased-restored.fixture.ts",
    "spy-namespace-restored.fixture.ts",
    "direct-global-restored.fixture.ts",
    "direct-module-restored.fixture.ts",
    "mock-helper-restored.fixture.ts",
    "local-shadow-cleared.fixture.ts",
    "intermediate-const-local.fixture.ts",
    "destructured-env-exempt.fixture.ts",
    "module-shadow-param-cleared.fixture.ts",
    "module-alias-shadow-cleared.fixture.ts",
    "process-env-cast-exempt.fixture.ts",
    "process-env-computed-exempt.fixture.ts",
  ]) {
    test(`clears ${name} (green fixture)`, () => {
      expect(findingsFor(name)).toEqual([]);
    });
  }

  test("reports each write in global-member-alias-leaked.fixture.ts (red fixture)", () => {
    const details = detailsFor("global-member-alias-leaked.fixture.ts");
    expect(details).toContain("assignment to 'process.exit' requires patchShared; inline restoration is refused");
    expect(details).toContain("assignment to 'D.now' requires patchShared; inline restoration is refused");
  });

  test("clears each write in shadow-nested-scope-cleared.fixture.ts (green fixture)", () => {
    const details = detailsFor("shadow-nested-scope-cleared.fixture.ts");
    for (const target of ["process.exit", "console.log", "globalThis.fetch"]) {
      expect(details.some((detail) => detail.includes(target))).toBe(false);
    }
  });

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

  test("names an unclassified mock assignment target", () => {
    expect(analyzeSource('import { mock, afterEach } from "bun:test"; afterEach(() => mock.restore()); getTarget().m = mock();'))
      .toContainEqual({ kind: "unclassified-assignment-target", detail: "cannot classify assignment target: getTarget().m" });
  });

  for (const rhs of ["mock(() => {})", "spyOn(object, 'm')", "mock.module('x', () => ({}))", "alias", "spy.mockImplementation(() => {})"]) {
    test(`refuses mock assignment: ${rhs}`, () => {
      expect(analyzeSource(`import { mock, spyOn, afterEach } from "bun:test";
        afterEach(() => mock.restore()); const alias = mock(); const spy = spyOn(object, 'm'); local.m = ${rhs};`)
        .map(finding => finding.kind)).toContain("direct-assignment-needs-restore");
    });
  }

  test("refuses a mock identifier bound by a logical assignment, each write on its own", () => {
    const details = analyzeSource(`import { mock, afterEach } from "bun:test"; afterEach(() => mock.restore());
      let replacement; replacement ||= mock(() => {}); object.m = replacement;`)
      .filter((finding) => finding.kind === "direct-assignment-needs-restore")
      .map((finding) => finding.detail);
    expect(details).toContain("assignment to 'replacement' requires patchShared; inline restoration is refused");
    expect(details).toContain("assignment to 'object.m' requires patchShared; inline restoration is refused");
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
});
