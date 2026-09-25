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
 * measurement can go quiet is a case below: a file no JUnit report names is
 * named, a missing report fails, an empty report fails, and a file a report
 * names passes. Nothing here asserts that a clause is present in a file — the
 * guard reads what RAN, and so do these tests.
 *
 * WHAT NO LONGER FEEDS THE EXECUTED SET: the suites' console logs. The guard used
 * to read them too, matching bun's per-file header lines, so a file bun executed
 * but its JUnit report omits (a file with ZERO test cases appears in no
 * `<testsuite>` and no `<testcase>`) still counted. A test that PRINTED a line
 * ending in `extra.test.ts:` could therefore put a file into the executed set
 * that never ran. The two cases below hold that shut: a log line naming an unrun
 * file does not count, and a file no report names fails — which is what a
 * zero-case file looks like — with the message that says how to register a case.
 * The last describe block drives the launchers, which delete their own suite's
 * report before the suite starts.
 *
 * The discovery rules asserted at the end are the ones measured against the
 * pinned bun (1.3.10), not the ones a changelog claims: `.test`/`_test`/`.spec`/
 * `_spec` before a js-ish extension, dot-directories skipped, `node_modules`
 * skipped, `dist/` NOT skipped, dot-files discovered.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPO,
  REQUIRED_SUITES,
  TEST_FILE_NAME,
  checkTestReports,
  discoverTestFiles,
  exitCodeFor,
  formatReport,
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
  "packages/cli/test/c.test.ts",
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
  /** Executed files per suite, as bun's JUnit report names them. */
  executed?: Record<string, string[]>;
  /** Files a suite's console LOG prints a header for (the report does not name them). */
  logSays?: Record<string, string[]>;
  /** Suite reports to leave out entirely. */
  omit?: string[];
  /** Test files the fixture tree holds (discovery's input). */
  discovered?: string[];
}

/**
 * A fixture repo: a tree of test files, one JUnit report + console log per
 * suite, and the discovered set. `logSays` builds the log a test would need in
 * order to forge coverage — a header line for a file the report never names.
 */
function fixture(options: FixtureOptions = {}): { readFile: (path: string) => string | undefined } {
  const {
    executed = {
      agent: ["test/a.test.ts"],
      cli: ["test/b.test.ts", "test/c.test.ts"],
      "root-test": ["test/root.test.ts"],
    },
    logSays = {},
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
    files.set(join(REPORT_DIR, `${suite}.log`), consoleLog([...ran, ...(logSays[suite] ?? [])]));
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
      "packages/cli/test/c.test.ts",
      "test/root.test.ts",
    ]);
    expect(formatReport(result)).toContain("OK: every test file on disk is shown executed");
  });

  test("a file no JUnit report names is NAMED, with what to do about it", () => {
    // What a file that registers ZERO test cases looks like: bun executes it, and
    // its JUnit report names it nowhere. It must fail, by name.
    const result = run({
      discovered: [...DEFAULT_DISCOVERED, "packages/cli/test/zero.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.orphans).toEqual(["packages/cli/test/zero.test.ts"]);
    expect(exitCodeFor(result)).toBe(1);
    const report = formatReport(result);
    expect(report).toContain("FAILED");
    expect(report).toContain(
      "packages/cli/test/zero.test.ts is a test file, and no JUnit report shows a suite executing it",
    );
    expect(report).toContain("registers ZERO test cases");
    expect(report).toContain("must register at least one case");
    expect(report).toContain("test.skip or test.todo");
    expect(report).toContain("describe.if / test.skipIf");
  });

  test("a log line naming an unrun file does not count — the log is not read", () => {
    // The forgery this replaced: a genuine report for the other files, plus a
    // printed line reading `zero.test.ts:`. The file is on disk and never in a
    // report, so it stays unexecuted however the log reads.
    const result = run({
      discovered: [...DEFAULT_DISCOVERED, "packages/cli/test/zero.test.ts"],
      logSays: { cli: ["test/zero.test.ts"] },
    });
    expect(result.ok).toBe(false);
    expect(result.orphans).toEqual(["packages/cli/test/zero.test.ts"]);
    expect(result.executed).not.toContain("packages/cli/test/zero.test.ts");
  });

  test("a MISSING report fails, naming the suite", () => {
    const result = run({ omit: ["cli.xml"] });
    expect(result.ok).toBe(false);
    // The report is the failure, AND its files are unaccounted for: with no
    // report there is nothing to show them executed, so they are named too.
    expect(result.failures.map((f) => f.kind)).toEqual(["missing-report", "unexecuted", "unexecuted"]);
    expect(result.failures[0]?.detail).toContain("test-reports/cli.xml");
    expect(result.orphans).toEqual(["packages/cli/test/b.test.ts", "packages/cli/test/c.test.ts"]);
    expect(formatReport(result)).toContain("NO REPORT");
  });

  test("an EMPTY report fails closed", () => {
    const { readFile } = fixture();
    const result = checkTestReports({
      rootDir: ROOT,
      reportDir: REPORT_DIR,
      suites: SUITES,
      readFile: (path) =>
        path === join(REPORT_DIR, "cli.xml")
          ? `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="0"></testsuites>\n`
          : readFile(path),
      discover: () => ["packages/agent/test/a.test.ts", "packages/cli/test/b.test.ts", "test/root.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(["empty-report", "unexecuted"]);
    expect(result.orphans).toEqual(["packages/cli/test/b.test.ts"]);
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
    expect(result.failures.map((f) => f.kind)).toEqual([
      "unreadable-report",
      "unexecuted",
      "unexecuted",
    ]);
    expect(result.orphans).toEqual(["packages/cli/test/b.test.ts", "packages/cli/test/c.test.ts"]);
  });

  test("the report's file attributes are resolved against the suite's own cwd", () => {
    const { readFile } = fixture({
      executed: { agent: ["test/security/mail.test.ts"], cli: [], "root-test": [] },
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

describe("the launchers delete their own suite's report before the suite starts", () => {
  /** A report + log left behind by an earlier step, in a throwaway dir. */
  function staleReportDir(prefix: string, suite: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(dir, `${suite}.xml`), junit(["test/stale.test.ts"]));
    writeFileSync(join(dir, `${suite}.log`), "STALE-MARKER\n");
    return dir;
  }

  test("scripts/test-suite.mjs removes its own report and log first", () => {
    const dir = staleReportDir("cli411-launcher-", "agent");
    try {
      // `--reporter=spec` is a caller's own reporter, so this run writes no JUnit
      // report at all: if `agent.xml` is gone afterwards, the launcher deleted it.
      const res = spawnSync(
        process.execPath,
        [join(REPO, "scripts/test-suite.mjs"), "agent", "--reporter=spec", join(dir, "no-such-file.test.ts")],
        { cwd: dir, env: { ...process.env, TPS_TEST_REPORT_DIR: dir }, encoding: "utf8" },
      );
      expect(res.error).toBeUndefined();
      expect(existsSync(join(dir, "agent.xml"))).toBe(false);
      expect(readFileSync(join(dir, "agent.log"), "utf8")).not.toContain("STALE-MARKER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the plugin launcher removes its own report and log first", () => {
    const dir = staleReportDir("cli411-plugin-launcher-", "plugin");
    try {
      const res = spawnSync(
        process.execPath,
        [
          join(REPO, "plugins/openclaw-tps-mail/scripts/run-tests.mjs"),
          "--reporter=spec",
          join(dir, "no-such-file.test.ts"),
        ],
        {
          cwd: join(REPO, "plugins/openclaw-tps-mail"),
          env: { ...process.env, TPS_TEST_REPORT_DIR: dir },
          encoding: "utf8",
        },
      );
      expect(res.error).toBeUndefined();
      // Past its setup, into the run: the isolated root line precedes the spawn.
      expect(res.stdout ?? "").toContain("openclaw-tps-mail tests: isolated root");
      expect(existsSync(join(dir, "plugin.xml"))).toBe(false);
      expect(readFileSync(join(dir, "plugin.log"), "utf8")).not.toContain("STALE-MARKER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseJunit", () => {
  test("parseJunit reads the file names out of a real-shaped report", () => {
    const parsed = parseJunit(junit(["test/a.test.ts", "test/b.test.ts"]));
    expect(parsed.testsuites.map((s) => s.file)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(parsed.testcases.map((c) => c.file)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  test("parseJunit sees nothing in a report bun wrote for a zero-case file", () => {
    const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="0"></testsuites>\n`;
    expect(parseJunit(empty).testsuites).toEqual([]);
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
