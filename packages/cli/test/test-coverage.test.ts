/**
 * test-coverage.test.ts — the cli#411 wiring guard's own tests.
 *
 * The guard is `scripts/check-test-coverage.mjs`: a standalone script, run as
 * its own step of the Unit & Integration Tests job. It is NOT this file — the
 * guard was moved out of this suite in round 2, because a guard that ran only
 * because the CLI suite ran could be disarmed by dropping the CLI suite from
 * the wiring, which is exactly the failure it exists to catch.
 *
 * What is left here is the guard's own test suite. It drives the guard's
 * exported functions over fixtures, so every way the wiring can go quiet is a
 * case below, and `checkTestCoverage` against the real repository is asserted
 * green the same way the CI step asserts it. A fixture that says "the clause is
 * in the file" is not enough anywhere: the guard reads what RUNS.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";
import {
  GUARD_COMMAND,
  GUARD_SCRIPT,
  REPO,
  TEST_FILE_NAME,
  WORKFLOW_FILE,
  bunTestCalls,
  checkTestCoverage,
  exitCodeFor,
  formatReport,
  posix,
  shellCommands,
  stripModuleComments,
  stripShellComments,
  testishScriptName,
  walkTestFiles,
  words,
} from "../../../scripts/check-test-coverage.mjs";

type Files = Record<string, string>;

interface Fixture {
  files: Files;
  testFiles: string[];
}

/** The root `test` script as it stands: three package suites, then the root dir. */
const ROOT_TEST_SCRIPT =
  "cd packages/agent && bun test && cd ../cli && bun test && cd ../pi-tps-mail && bun test && " +
  "cd ../.. && bun test ./test";

/** The plugin's launcher, reduced to the line that names the roots it runs. */
const LAUNCHER = [
  'import { spawn } from "node:child_process";',
  'const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
  "const passthrough = process.argv.slice(2);",
  'const child = spawn("bun", ["test", ...(passthrough.length ? passthrough : ["test/"])], {',
  "  cwd: pluginDir,",
  "});",
].join("\n");

/** A workflow shaped like the real one: the root test script, and the plugin step. */
const WORKFLOW = [
  "jobs:",
  "  test:",
  "    name: Unit & Integration Tests",
  "    steps:",
  "      - run: bun run test",
  "      - name: openclaw-tps-mail plugin tests (isolated HOME launcher)",
  "        working-directory: plugins/openclaw-tps-mail",
  "        run: |",
  "          npm ci --ignore-scripts",
  "          npm run build",
  "          bun run test",
].join("\n");

const PLUGIN_STEP = [
  "      - name: openclaw-tps-mail plugin tests (isolated HOME launcher)",
  "        working-directory: plugins/openclaw-tps-mail",
  "        run: |",
  "          npm ci --ignore-scripts",
  "          npm run build",
  "          bun run test",
].join("\n");

/** The four suites and the file each one owns, for the "clause dropped" cases. */
const SUITES = [
  { clause: "cd packages/agent && bun test && ", file: "packages/agent/test/a.test.ts", root: "packages/agent" },
  { clause: "cd ../cli && bun test && ", file: "packages/cli/test/b.test.ts", root: "packages/cli" },
  { clause: "cd ../pi-tps-mail && bun test && ", file: "packages/pi-tps-mail/test/c.test.ts", root: "packages/pi-tps-mail" },
  { clause: "cd ../.. && bun test ./test", file: "test/e.test.ts", root: "test" },
];

function fixture(override: Partial<Fixture> = {}): Fixture {
  return {
    files: {
      "package.json": JSON.stringify({ scripts: { test: ROOT_TEST_SCRIPT } }),
      [WORKFLOW_FILE]: WORKFLOW,
      "plugins/openclaw-tps-mail/package.json": JSON.stringify({
        scripts: { test: "node scripts/run-tests.mjs" },
      }),
      "plugins/openclaw-tps-mail/scripts/run-tests.mjs": LAUNCHER,
      ...(override.files ?? {}),
    },
    testFiles: override.testFiles ?? [
      "packages/agent/test/a.test.ts",
      "packages/cli/test/b.test.ts",
      "packages/pi-tps-mail/test/c.test.ts",
      "plugins/openclaw-tps-mail/test/d.test.ts",
      "test/e.test.ts",
    ],
  };
}

const FIXTURE_ROOT = "/fixture";

function check(fixtureFiles: Fixture) {
  const { files } = fixtureFiles;
  return checkTestCoverage({
    rootDir: FIXTURE_ROOT,
    readFile: (path: string) => {
      const rel = posix(relative(FIXTURE_ROOT, path));
      return Object.hasOwn(files, rel) ? files[rel] : undefined;
    },
    listTestFiles: () => fixtureFiles.testFiles,
  });
}

/** The guard against the actual repository — the CI step's own assertion. */
function checkRepo() {
  return checkTestCoverage({
    rootDir: REPO,
    readFile: (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    listTestFiles: () => walkTestFiles(REPO),
  });
}

const rootsOf = (result: { roots: { root: string }[] }) => result.roots.map((entry) => entry.root);

describe("the guard is its own CI step, not a suite clause (cli#411 round 2)", () => {
  test("it runs as its own step of the Unit & Integration Tests job", () => {
    const workflow = yaml.load(readFileSync(join(REPO, WORKFLOW_FILE), "utf8")) as {
      jobs: Record<string, { steps: { run?: string; "working-directory"?: string }[] }>;
    };
    const steps = workflow.jobs.test.steps;
    const guardSteps = steps.filter((step) => step.run?.includes(GUARD_SCRIPT));
    // Exactly one step, and it is the guard itself — not a suite that runs it.
    expect(guardSteps.length, "the guard must be exactly one step of the job").toBe(1);
    expect(guardSteps[0].run?.trim()).toBe(GUARD_COMMAND);
    expect(guardSteps[0]["working-directory"]).toBeUndefined();
  });

  test("the guard is a script, not a test file inside a suite it polices", () => {
    expect(GUARD_SCRIPT.startsWith("scripts/")).toBe(true);
    expect(TEST_FILE_NAME.test(GUARD_SCRIPT)).toBe(false);
  });

  test("dropping a suite clause leaves the guard failing, not silent", () => {
    // The round-2 property, stated directly: with any one suite clause gone the
    // guard still returns a failing verdict (exit 1) naming what it lost.
    for (const { clause, file } of SUITES) {
      const f = fixture({
        files: { "package.json": JSON.stringify({ scripts: { test: ROOT_TEST_SCRIPT.replace(clause, "") } }) },
      });
      const result = check(f);
      expect(result.orphans, `expected ${file} to be orphaned`).toContain(file);
      expect(exitCodeFor(result), `${file}'s suite clause`).toBe(1);
      expect(formatReport(result)).toContain("FAILED");
    }
    const noPluginStep = fixture({ files: { [WORKFLOW_FILE]: WORKFLOW.replace(PLUGIN_STEP, "") } });
    const result = check(noPluginStep);
    expect(result.orphans).toContain("plugins/openclaw-tps-mail/test/d.test.ts");
    expect(exitCodeFor(result)).toBe(1);
  });
});

describe("the covered roots come from configuration (cli#411)", () => {
  test("an untouched fixture is green, and derives all five roots", () => {
    const result = check(fixture());
    expect(result.unresolved).toEqual([]);
    expect(rootsOf(result).sort()).toEqual([
      "packages/agent",
      "packages/cli",
      "packages/pi-tps-mail",
      "plugins/openclaw-tps-mail/test",
      "test",
    ]);
    expect(result.orphans).toEqual([]);
    expect(result.ok).toBe(true);
    expect(exitCodeFor(result)).toBe(0);
  });

  test("the plugin's root is the launcher's test root, not the plugin directory", () => {
    // cli#411 round 2, item 3: the launcher runs `bun test test/` inside the
    // plugin, so the plugin DIRECTORY is not a covered root.
    const result = check(fixture());
    expect(rootsOf(result)).toContain("plugins/openclaw-tps-mail/test");
    expect(rootsOf(result)).not.toContain("plugins/openclaw-tps-mail");
  });

  test("a test file under the plugin but outside its test/ is an orphan", () => {
    const f = fixture();
    f.testFiles = [...f.testFiles, "plugins/openclaw-tps-mail/extra.test.ts"];
    const result = check(f);
    expect(result.orphans).toEqual(["plugins/openclaw-tps-mail/extra.test.ts"]);
    expect(exitCodeFor(result)).toBe(1);
  });

  test("a clause in a script nothing runs covers nothing", () => {
    const f = fixture({
      files: {
        "package.json": JSON.stringify({
          scripts: {
            test: "cd packages/agent && bun test",
            "test:root": "cd ../.. && bun test ./test", // never called
          },
        }),
      },
    });
    // The wiring text IS in the file — a search over package.json would pass.
    expect(f.files["package.json"]).toContain("bun test ./test");
    const result = check(f);
    expect(result.orphans).toContain("test/e.test.ts");
    expect(exitCodeFor(result)).toBe(1);
  });

  test("a clause in a comment covers nothing — a YAML comment and a shell one", () => {
    const yamlComment = fixture({
      files: {
        [WORKFLOW_FILE]: WORKFLOW.replace(
          PLUGIN_STEP,
          "      # - working-directory: plugins/openclaw-tps-mail\n      #   run: bun run test",
        ),
      },
    });
    // The text is still in the workflow file — counting text would pass.
    expect(yamlComment.files[WORKFLOW_FILE]).toContain("run: bun run test");
    const fromYaml = check(yamlComment);
    expect(fromYaml.orphans).toContain("plugins/openclaw-tps-mail/test/d.test.ts");
    expect(exitCodeFor(fromYaml)).toBe(1);

    const shellComment = fixture({
      files: { [WORKFLOW_FILE]: WORKFLOW.replace("          bun run test", "          # bun run test") },
    });
    const fromShell = check(shellComment);
    expect(fromShell.orphans).toContain("plugins/openclaw-tps-mail/test/d.test.ts");
    expect(exitCodeFor(fromShell)).toBe(1);
  });

  test("each suite clause removed is caught, naming that suite's files", () => {
    for (const { clause, file, root } of SUITES) {
      const f = fixture({
        files: { "package.json": JSON.stringify({ scripts: { test: ROOT_TEST_SCRIPT.replace(clause, "") } }) },
      });
      const result = check(f);
      expect(rootsOf(result), `${root} must no longer be covered`).not.toContain(root);
      expect(result.orphans, `${file} must be reported`).toContain(file);
      expect(exitCodeFor(result)).toBe(1);
    }
  });

  test("a test run the guard cannot read is UNRESOLVED, never assumed covered", () => {
    // The launcher is gone: `bun run test` names a test run whose roots are unreadable.
    const missing = fixture();
    delete missing.files["plugins/openclaw-tps-mail/scripts/run-tests.mjs"];
    const unreadable = check(missing);
    expect(unreadable.unresolved.length).toBeGreaterThan(0);
    expect(exitCodeFor(unreadable)).toBe(1);
    expect(formatReport(unreadable)).toContain("UNRESOLVED");

    // The launcher passes a VARIABLE: the roots it runs are unknown, so the
    // guard must not widen to the plugin directory and must not pass.
    const dynamic = fixture({
      files: {
        "plugins/openclaw-tps-mail/scripts/run-tests.mjs":
          'const child = spawn("bun", ["test", ...args], { cwd: pluginDir });\n',
      },
    });
    const guessed = check(dynamic);
    expect(guessed.unresolved.some((entry) => entry.source.includes("run-tests.mjs"))).toBe(true);
    expect(rootsOf(guessed)).not.toContain("plugins/openclaw-tps-mail");
    expect(exitCodeFor(guessed)).toBe(1);
  });

  test("a launcher whose only invocation is in a docblock is unresolved, not the cwd", () => {
    // A traced module's own documentation must not widen the covered set: with
    // the invocation commented out, `bun run test` has no readable root.
    const f = fixture({
      files: {
        "plugins/openclaw-tps-mail/scripts/run-tests.mjs":
          '// spawn("bun", ["test", "test/"]);\nconsole.log("nothing runs tests here");\n',
      },
    });
    const result = check(f);
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(rootsOf(result)).not.toContain("plugins/openclaw-tps-mail");
    expect(exitCodeFor(result)).toBe(1);
  });

  test("a bare `bun test` at the repo root covers the repository, as bun would", () => {
    const f = fixture({
      files: { [WORKFLOW_FILE]: "jobs:\n  test:\n    steps:\n      - run: cd packages/agent && bun test\n" },
    });
    f.testFiles = ["packages/agent/test/a.test.ts", "packages/agent/test/deeper/b.test.ts"];
    const result = check(f);
    expect(rootsOf(result)).toEqual(["packages/agent"]);
    expect(result.orphans).toEqual([]);
  });
});

describe("reading shell and module wiring (cli#411)", () => {
  test("comments are not commands, quoted hashes are not comments", () => {
    expect(stripShellComments("bun run test # not this\n")).toBe("bun run test \n");
    expect(stripShellComments("echo \"a # b\"\n")).toBe("echo \"a # b\"\n");
    expect(stripShellComments("# bun test ./test\nbun run test\n")).toBe("\nbun run test\n");
    expect(shellCommands("a\nb && c || d; e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(words('cd "a b" && bun test')).toEqual(["cd", "a b", "&&", "bun", "test"]);
  });

  test("a module's comments are not invocations", () => {
    expect(stripModuleComments('// spawn("bun", ["test", "test/"]);\nspawn("bun", ["test"]);')).toBe(
      '\nspawn("bun", ["test"]);',
    );
    expect(stripModuleComments('/* spawn("bun", ["test"]); */\nx()\n')).toBe("\nx()\n");
    expect(stripModuleComments('const url = "a // b"; // gone\n')).toBe('const url = "a // b"; \n');
  });

  test("a test-ish script name is recognised, a shell fixture is not", () => {
    for (const name of ["test", "test:unit", "test:raw"]) expect(testishScriptName(name), name).toBe(true);
    for (const name of ["build", "lint:ci", "pretest-x", "testing"]) {
      expect(testishScriptName(name), name).toBe(false);
    }
  });

  test("the launcher's bun arguments are read as literals", () => {
    expect(bunTestCalls(LAUNCHER)).toEqual([{ kind: "test", args: ["test/"], dynamic: false }]);
    // A literal default inside a ternary is the default CI runs.
    expect(bunTestCalls('spawn("bun", ["test", ...(keep ? keep : ["test/", "x.test.ts"])]);')).toEqual([
      { kind: "test", args: ["test/", "x.test.ts"], dynamic: false },
    ]);
    // No path literal, only a variable: the guard must not invent one.
    expect(bunTestCalls('spawn("bun", ["test", ...args]);')).toEqual([
      { kind: "test", args: [], dynamic: true },
    ]);
    // A bare `bun test` is not dynamic: it runs the cwd.
    expect(bunTestCalls('spawn("bun", ["test"]);')).toEqual([{ kind: "test", args: [], dynamic: false }]);
    // `bun run <script>` is followed, not guessed.
    expect(bunTestCalls('spawn("bun", ["run", "test:raw"]);')).toEqual([{ kind: "run", name: "test:raw" }]);
  });
});

describe("the real repository's wiring (cli#411)", () => {
  test("the scan's filename pattern matches every name bun discovers", () => {
    for (const name of ["x.test.ts", "x_test.ts", "x.spec.ts", "x_spec.ts", "x.test.js", "x_spec.mjs"]) {
      expect(TEST_FILE_NAME.test(name), name).toBe(true);
    }
    expect(TEST_FILE_NAME.test("x.ts")).toBe(false);
    expect(TEST_FILE_NAME.test("contest.ts")).toBe(false);
  });

  test("discovered paths compare against forward-slash prefixes (Windows-safe)", () => {
    expect(posix("packages\\cli\\test\\x.test.ts")).toBe("packages/cli/test/x.test.ts");
    expect(walkTestFiles(REPO).every((file) => !file.includes("\\"))).toBe(true);
  });

  test("every test file in the repository is inside a suite CI runs", () => {
    const result = checkRepo();
    // The walk must have seen the repository: a scan that found nothing (a moved
    // root, a renamed pattern) would otherwise read as "no orphans".
    expect(result.files.length).toBeGreaterThan(100);
    expect(result.files).toContain("test/security-properties.test.ts");
    // The root test/ directory is wired into the root test script (the cli#411
    // regression), and the plugin's root is its test/ directory (round 2).
    expect(result.unresolved).toEqual([]);
    expect(rootsOf(result).sort()).toEqual([
      "packages/agent",
      "packages/cli",
      "packages/pi-tps-mail",
      "plugins/openclaw-tps-mail/test",
      "test",
    ]);
    expect(result.orphans).toEqual([]);
    expect(result.emptyRoots).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
