/**
 * env-leak-guard.test.ts — cli#555: the process.env check in the cli test leak
 * preload (helpers/env-leak-preload.ts, run by helpers/leak-preload.ts, listed
 * in packages/cli/bunfig.toml).
 *
 * Each fixture under fixtures/env-leak-guard/ is copied to a temp dir as a
 * *.test.ts file and run in a child bun with the preload, so the real plugin,
 * the real afterAll ordering and the real process.env decide the result.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFiles } from "./helpers/env-leak-preload.js";

const PRELOAD = join(import.meta.dir, "helpers", "leak-preload.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "env-leak-guard");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runFixture(name: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "tps-env-leak-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURES, `${name}.fixture.ts`), join(dir, `${name}.test.ts`));
  const env: Record<string, string | undefined> = { ...process.env, TPS_FIXTURE_PRESENT: "original" };
  delete env.TPS_FIXTURE_ABSENT;
  delete env.TPS_FIXTURE_VALUE;
  const run = spawnSync(process.execPath, [`--preload=${PRELOAD}`, "test", `./${name}.test.ts`], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describe("env leak preload (cli#555)", () => {
  test("this file was loaded through the preload", () => {
    expect(guardedFiles()).toContain(import.meta.path);
  });

  for (const [name, verdict] of [
    ["env-leaked", "added TPS_FIXTURE_VALUE"],
    ["env-dead-cleanup", "added TPS_FIXTURE_VALUE"],
    ["env-wrong-value", "changed TPS_FIXTURE_PRESENT"],
    ["env-late-snapshot", "added TPS_FIXTURE_VALUE"],
    ["env-whole-snapshot", "added TPS_FIXTURE_VALUE"],
  ] as const) {
    test(`fails ${name} and reports "${verdict}" (red fixture)`, () => {
      const run = runFixture(name);
      expect(run.status, run.output).not.toBe(0);
      expect(run.output).toContain(`left process.env different from when it loaded: ${verdict}`);
    });
  }

  test("passes env-restored, which puts a present name back and removes an absent one (green fixture)", () => {
    const run = runFixture("env-restored");
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("left process.env different");
    expect(run.output).toContain("2 pass");
  });
});
