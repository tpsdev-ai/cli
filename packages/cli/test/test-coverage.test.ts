import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * cli#411 — a test file no suite runs is a test that cannot fail.
 *
 * `test/security-properties.test.ts` at the repo root asserted the supervisor's
 * socket, secrets-gate, signal and launch properties, and nothing ran it:
 * `bun run test` walked the three package suites only, and no workflow step
 * invoked the root directory. These assertions are the wiring's own guard.
 *
 * WHY THIS FILE LIVES IN THIS SUITE, NOT IN THE DIRECTORY IT POLICES.
 * A guard inside the root `test/` directory would be run only because of the
 * very wiring it checks — delete that one clause from the root `test` script
 * and the guard stops running, silently, which is the failure it exists to
 * catch. This suite is run by `bun run test` on every PR today, so the guard
 * runs whether or not the root directory is wired, and says which it is.
 */

/** The repo root, from this file's own location: <root>/packages/cli/test/…. */
const ROOT = resolve(import.meta.dir, "../../..");

function rootFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

/** The file names bun's test discovery picks up (`.` and `_test` forms). */
const TEST_FILE_NAME = /(?:\.test|\.spec|_test)\.[cm]?[jt]sx?$/;

/** Every test file in the repo, repo-relative and sorted. `node_modules`/`.git` aside. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE_NAME.test(entry.name)) found.push(relative(ROOT, path));
    }
  };
  walk(ROOT);
  return found.sort();
}

/** The steps of the job that runs the tests, split on the step-list indentation. */
function ciSteps(): string[] {
  return rootFile(".github/workflows/test.yml").split(/\n(?= {6}- )/);
}

/** The directories a workflow step runs its own test script in. */
function ciSuiteDirs(): string[] {
  return ciSteps()
    .filter((step) => /\brun test\b/.test(step))
    .map((step) => /working-directory:\s*(\S+)/.exec(step)?.[1])
    .filter((dir): dir is string => dir !== undefined);
}

/**
 * Every directory a suite runs, with the wiring text that proves it is still
 * run. The proof is an exact substring of the file that wires the suite, so
 * dropping a suite from the wiring fails here rather than quietly orphaning
 * every file under it.
 */
const WIRED: { dir: string; file: string; contains: string }[] = [
  { dir: "packages/agent", file: "package.json", contains: "cd packages/agent && bun test" },
  { dir: "packages/cli", file: "package.json", contains: "cd ../cli && bun test" },
  { dir: "packages/pi-tps-mail", file: "package.json", contains: "cd ../pi-tps-mail && bun test" },
  { dir: "test", file: "package.json", contains: "bun test ./test" },
];

/**
 * The directories a suite really runs right now: a `WIRED` entry counts only
 * while its proof is present in the file that wires it. A directory whose
 * wiring was dropped stops counting here, so the files under it are reported as
 * orphans by the scan below instead of being covered on the table's say-so.
 */
function coveredDirs(): string[] {
  const fromScript = WIRED.filter((w) => rootFile(w.file).includes(w.contains)).map((w) => w.dir);
  return [...fromScript, ...ciSuiteDirs()];
}

function covers(dir: string, file: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

describe("every test file is run by a suite CI runs (cli#411)", () => {
  test("the root test/ directory is wired into the root test script", () => {
    // The regression cli#411 filed: the root directory's tests ran nowhere.
    expect(rootFile("package.json")).toContain("bun test ./test");
    expect(testFiles().filter((file) => covers("test", file)).length).toBeGreaterThan(0);
  });

  test("each package suite is still wired into the root test script", () => {
    for (const { dir, file, contains } of WIRED) {
      expect(rootFile(file), `${dir} is no longer run from ${file}`).toContain(contains);
    }
  });

  test("the plugin suite is still wired into a workflow step", () => {
    expect(ciSuiteDirs()).toContain("plugins/openclaw-tps-mail");
  });

  test("no test file lives outside a directory a suite runs", () => {
    const files = testFiles();
    // The walk must have seen the repo: a scan that found nothing (a moved
    // ROOT, a renamed pattern) would otherwise read as "no orphans".
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("test/security-properties.test.ts");

    const dirs = coveredDirs();
    const orphans = files.filter((file) => !dirs.some((dir) => covers(dir, file)));

    expect(
      orphans,
      "test files no suite runs — wire a runner for them (a suite in the root `test` " +
        "script, or a step in .github/workflows/test.yml) or move them under a " +
        `directory that is already run:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  test("every covered directory holds at least one test", () => {
    const files = testFiles();
    for (const dir of coveredDirs()) {
      expect(files.some((file) => covers(dir, file)), `no test files under ${dir}`).toBe(true);
    }
  });
});
