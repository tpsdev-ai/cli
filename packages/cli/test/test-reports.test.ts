/**
 * test-reports.test.ts — the cli#411 coverage guard's own tests.
 *
 * The guard is `scripts/check-test-reports.mjs`: a standalone script, run as the
 * LAST step of the Unit & Integration Tests job with `if: always()`. It is NOT
 * this file — the guard was moved out of the suite in round 2 and out of the
 * wiring in round 3, because a guard that ran only because a suite (or the
 * wiring it polices) was intact could be disarmed by dropping either, which is
 * exactly the failure it exists to catch.
 *
 * What is left here is the guard's own test suite. It drives the guard's
 * exported functions over fixture reports and a fixture tree, so every way the
 * measurement can go quiet is a case below: a file no report shows executed is
 * named, a missing report fails, an empty report fails, and a file a report
 * names passes. Nothing here asserts that a clause is present in a file — the
 * guard reads what RAN, and so do these tests.
 *
 * The discovery rules asserted at the end are the ones measured against the
 * pinned bun (1.3.10), not the ones a changelog claims: `.test`/`_test`/`.spec`/
 * `_spec` before a js-ish extension, dot-directories skipped, `node_modules`
 * skipped, `dist/` NOT skipped, dot-files discovered.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_SUITES,
  TEST_FILE_NAME,
  checkTestReports,
  discoverTestFiles,
  exitCodeFor,
  formatReport,
  parseExecutedFromLog,
  parseJunit,
} from "../../../scripts/check-test-reports.mjs";

/** A fixture root that need not exist on disk: every read below is injected. */
const ROOT = "/fixture-repo";
const REPORT_DIR = join(ROOT, "test-reports");
const SUITES = [
  { suite: "agent", cwd: "packages/agent" },
  { suite: "cli", cwd: "packages/cli" },
  { suite: "root-test", cwd: "." },
];

/** The fixture tree's test files, as discovery would report them. */
const DEFAULT_DISCOVERED = [
  "packages/agent/test/a.test.ts",
  "packages/cli/test/b.test.ts",
  "packages/cli/test/c-zero.test.ts",
  "test/root.test.ts",
];

/** bun's JUnit reporter for a run that executed `files`. */
function junit(files: string[]): string {
  const suites = files
    .map(
      (file) =>
        `  <testsuite name="${file}" file="${file}" tests="1" assertions="1">\n` +
        `    <testcase name="a case" classname="" time="0.001" file="${file}" line="1" assertions="1" />\n` +
        `  </testsuite>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${files.length}">\n${suites}\n</testsuites>\n`;
}

/** bun's console reporter: a bare `<path>:` header per file it ran. */
function consoleLog(files: string[]): string {
  return `bun test v1.3.10\n\n${files.map((file) => `${file}:\n(pass) a case [0.04ms]\n`).join("\n")} ${files.length} pass\n 0 fail\nRan ${files.length} tests across ${files.length} files. [50.00ms]\n`;
}

interface FixtureOptions {
  /** Executed files per suite, as bun's report and log name them. */
  executed?: Record<string, string[]>;
  /** Files present in the report but named nowhere in the log, and vice versa. */
  logOnly?: Record<string, string[]>;
  /** Suite reports/logs to leave out entirely. */
  omit?: string[];
  /** Test files the fixture tree holds (discovery's input). */
  discovered?: string[];
}

/**
 * A fixture repo: a tree of test files, one JUnit report + console log per
 * suite, and the discovered set. By default the cli suite's log names a file its
 * report does NOT (`test/c-zero.test.ts`) — exactly how a file with zero test
 * cases looks, since bun's console reporter prints its header and its JUnit
 * reporter omits it.
 */
function fixture(options: FixtureOptions = {}): { readFile: (path: string) => string | undefined } {
  const {
    executed = {
      agent: ["test/a.test.ts"],
      cli: ["test/b.test.ts"],
      "root-test": ["test/root.test.ts"],
    },
    logOnly = { cli: ["test/c-zero.test.ts"] },
    omit = [],
    discovered = DEFAULT_DISCOVERED,
  } = options;
  const files = new Map<string, string>();
  for (const file of discovered) files.set(join(ROOT, file), "// fixture test file\n");
  for (const { suite } of SUITES) {
    const ran = executed[suite] ?? [];
    if (!omit.includes(`${suite}.xml`)) {
      files.set(join(REPORT_DIR, `${suite}.xml`), junit(ran));
    }
    if (!omit.includes(`${suite}.log`)) {
      files.set(join(REPORT_DIR, `${suite}.log`), consoleLog([...ran, ...(logOnly[suite] ?? [])]));
    }
  }
  return { readFile: (path) => files.get(path) };
}

/** Run the guard over the fixture, with discovery pinned to the fixture tree. */
const run = (options: FixtureOptions = {}) => {
  const { readFile } = fixture(options);
  return checkTestReports({
    rootDir: ROOT,
    reportDir: REPORT_DIR,
    suites: SUITES,
    readFile,
    discover: () => [...(options.discovered ?? DEFAULT_DISCOVERED)].sort(),
  });
};

describe("check-test-reports", () => {
  test("a file a report names passes (and the check is green)", () => {
    const result = run();
    expect(result.ok).toBe(true);
    expect(result.orphans).toEqual([]);
    expect(exitCodeFor(result)).toBe(0);
    expect(result.executed).toEqual([
      "packages/agent/test/a.test.ts",
      "packages/cli/test/b.test.ts",
      "packages/cli/test/c-zero.test.ts",
      "test/root.test.ts",
    ]);
    expect(formatReport(result)).toContain("OK: every test file on disk is shown executed");
  });

  test("a file no report shows executed is NAMED", () => {
    const result = run({
      discovered: ["packages/agent/test/a.test.ts", "packages/cli/test/orphan.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.orphans).toEqual(["packages/cli/test/orphan.test.ts"]);
    expect(exitCodeFor(result)).toBe(1);
    const report = formatReport(result);
    expect(report).toContain("FAILED");
    expect(report).toContain("packages/cli/test/orphan.test.ts is a test file, and no report shows a suite executing it");
  });

  test("a MISSING report fails, naming the suite", () => {
    const result = run({ omit: ["cli.xml"] });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(["missing-report"]);
    expect(result.failures[0]?.detail).toContain("test-reports/cli.xml");
    expect(formatReport(result)).toContain("NO REPORT");
  });

  test("an EMPTY report fails closed", () => {
    const { readFile } = fixture();
    const result = checkTestReports({
      rootDir: ROOT,
      reportDir: REPORT_DIR,
      suites: SUITES,
      readFile: (path) =>
        path === join(REPORT_DIR, "cli.xml") ? `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="0"></testsuites>\n` : readFile(path),
      discover: () => ["packages/agent/test/a.test.ts", "packages/cli/test/b.test.ts", "test/root.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(["empty-report"]);
    expect(formatReport(result)).toContain("EMPTY REPORT");
  });

  test("a report with no <testsuites> at all fails closed too", () => {
    const { readFile } = fixture();
    const result = checkTestReports({
      rootDir: ROOT,
      reportDir: REPORT_DIR,
      suites: SUITES,
      readFile: (path) => (path === join(REPORT_DIR, "cli.xml") ? "not a report\n" : readFile(path)),
      discover: () => [...DEFAULT_DISCOVERED].sort(),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(["unreadable-report"]);
  });

  test("a file with ZERO test cases rides its suite's LOG, and a missing log fails closed", () => {
    // bun 1.3.10's JUnit report omits a file with no cases: it is in the log's
    // per-file headers only. That file must still count as executed.
    const withLog = run();
    expect(withLog.ok).toBe(true);
    expect(withLog.executed).toContain("packages/cli/test/c-zero.test.ts");

    // Without the log that file is visible nowhere — the check fails, naming it,
    // rather than passing on a report that cannot see it.
    const withoutLog = run({ omit: ["cli.log"] });
    expect(withoutLog.ok).toBe(false);
    expect(withoutLog.failures.map((f) => f.kind)).toEqual(["missing-log", "unexecuted"]);
    expect(withoutLog.orphans).toEqual(["packages/cli/test/c-zero.test.ts"]);
  });

  test("the report's file attributes are resolved against the suite's own cwd", () => {
    const { readFile } = fixture({
      executed: { agent: ["test/security/mail.test.ts"], cli: [], "root-test": [] },
      logOnly: {},
    });
    const result = checkTestReports({
      rootDir: ROOT,
      reportDir: REPORT_DIR,
      suites: SUITES,
      readFile,
      discover: () => ["packages/agent/test/security/mail.test.ts"],
    });
    // `test/security/mail.test.ts` in the agent suite's report is under
    // packages/agent, not at the repo root — resolving it against the wrong cwd
    // would leave the real file an orphan.
    expect(result.orphans).toEqual([]);
    expect(result.executed).toEqual(["packages/agent/test/security/mail.test.ts"]);
  });

  test("the guard requires every suite CI runs, and a report path per suite", () => {
    expect([...REQUIRED_SUITES].map((s) => s.suite).sort()).toEqual([
      "agent",
      "cli",
      "pi-tps-mail",
      "plugin",
      "root-test",
    ]);
    // Each suite's cwd is where its own `bun test` runs; the plugin's is the
    // plugin directory, so `test/…` in its report is the plugin's test dir.
    expect(REQUIRED_SUITES.find((s) => s.suite === "plugin")?.cwd).toBe("plugins/openclaw-tps-mail");
  });
});

describe("parseJunit / parseExecutedFromLog", () => {
  test("parseJunit reads the file names out of a real-shaped report", () => {
    const parsed = parseJunit(junit(["test/a.test.ts", "test/b.test.ts"]));
    expect(parsed.testsuites.map((s) => s.file)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(parsed.testcases.map((c) => c.file)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  test("parseJunit sees nothing in a report bun wrote for a zero-case file", () => {
    const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="0"></testsuites>\n`;
    expect(parseJunit(empty).testsuites).toEqual([]);
  });

  test("a log header counts only when it names a test file that exists", () => {
    const exists = (path: string) => path === join(ROOT, "packages/cli/test/b.test.ts");
    const log = [
      "test/b.test.ts:",
      "(pass) a case [0.04ms]",
      "not a test file:",
      "test/missing.test.ts:",
      "(pass) printed by a test that ends in a colon:",
    ].join("\n");
    expect([...parseExecutedFromLog(log, join(ROOT, "packages/cli"), ROOT, exists)]).toEqual([
      "packages/cli/test/b.test.ts",
    ]);
  });

  test("ANSI-colored headers (a local TTY run) are still read", () => {
    const exists = () => true;
    const log = "\u001b[36mtest/b.test.ts\u001b[0m:\n";
    expect([...parseExecutedFromLog(log, join(ROOT, "packages/cli"), ROOT, exists)]).toEqual([
      "packages/cli/test/b.test.ts",
    ]);
  });
});

describe("discoverTestFiles — bun 1.3.10's discovery, measured", () => {
  test("every form bun discovers, and only those", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli411-discovery-"));
    try {
      const write = (rel: string) => {
        const path = join(dir, rel);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "// fixture\n");
      };
      const discovered = [
        "a.test.ts",
        "b_test.ts",
        "c.spec.ts",
        "d_spec.js",
        "e.test.mts",
        "f.test.cts",
        "g.test.tsx",
        "h.test.mjs",
        "sub/i.test.js",
        "dist/j.test.js",
        ".dotfile.test.ts",
      ];
      const missed = [
        "foo.test.helper.ts",
        "foo-spec.ts",
        "foo_test_helper.ts",
        "plain.ts",
        "readme.md",
        "node_modules/k.test.ts",
        ".dotdir/l.test.ts",
      ];
      for (const file of [...discovered, ...missed]) write(file);

      expect(discoverTestFiles(dir)).toEqual(
        [
          ".dotfile.test.ts",
          "a.test.ts",
          "b_test.ts",
          "c.spec.ts",
          "d_spec.js",
          "dist/j.test.js",
          "e.test.mts",
          "f.test.cts",
          "g.test.tsx",
          "h.test.mjs",
          "sub/i.test.js",
        ].sort(),
      );
      // The name rule itself, spelled out: it is a suffix before the extension,
      // not a substring — `foo.test.helper.ts` is not a test file to bun.
      expect(TEST_FILE_NAME.test("foo.test.helper.ts")).toBe(false);
      expect(TEST_FILE_NAME.test("foo-spec.ts")).toBe(false);
      expect(TEST_FILE_NAME.test("foo.spec.ts")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
