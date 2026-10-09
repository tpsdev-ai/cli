/**
 * global-leak-guard.test.ts — cli#568: the guarded-global check in the cli test
 * leak preload (helpers/global-leak-preload.ts, run by helpers/leak-preload.ts,
 * listed in packages/cli/bunfig.toml).
 *
 * Each fixture under fixtures/global-leak-guard/ is copied to a temp dir as a
 * *.test.ts file and run in a child bun with the preload, so the real plugin,
 * the real afterAll ordering and the real globals decide the result.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { guardedGlobalFiles } from "./helpers/global-leak-preload.js";

const PRELOAD = join(import.meta.dir, "helpers", "leak-preload.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "global-leak-guard");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runFixture(name: string, copy: string[] = []): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "tps-global-leak-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURES, `${name}.fixture.ts`), join(dir, `${name}.test.ts`));
  for (const file of copy) copyFileSync(file, join(dir, basename(file)));
  const run = spawnSync(process.execPath, [`--preload=${PRELOAD}`, "test", `./${name}.test.ts`], {
    cwd: dir,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describe("guarded-global preload (cli#568)", () => {
  test("this file was loaded through the preload", () => {
    expect(guardedGlobalFiles()).toContain(import.meta.path);
  });

  test("fails global-leaked and names globalThis.fetch (red fixture)", () => {
    const run = runFixture("global-leaked");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("left a guarded global changed from when it loaded: globalThis.fetch");
  });

  test("fails immediate-leaked and names globalThis.setImmediate (red fixture)", () => {
    const run = runFixture("immediate-leaked");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("left a guarded global changed from when it loaded: globalThis.setImmediate");
  });

  test("passes global-restored, which puts fetch back (green fixture)", () => {
    const run = runFixture("global-restored");
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("left a guarded global changed");
    expect(run.output).toContain("1 pass");
  });

  test("passes hook-patched through case cleanup (green fixture)", () => {
    const run = runFixture("hook-patched", [join(import.meta.dir, "helpers", "patch-shared.ts")]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("2 pass");
  });

  test("passes global-patched, which patches fetch twice through the patchShared helper (green fixture)", () => {
    const run = runFixture("global-patched", [join(import.meta.dir, "helpers", "patch-shared.ts")]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("left a guarded global changed");
    expect(run.output).toContain("1 pass");
  });
});
