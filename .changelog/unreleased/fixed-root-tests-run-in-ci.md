- **The root `test/` directory now runs in CI, and a test file no suite runs fails the build (cli#411).**

  CI runs the root security-property tests and checks required JUnit reports
  against discovered test files, failing on missing reports or uncovered files.
  The root `test` script runs the root `./test` directory through the suite
  runner (`node scripts/test-suite.mjs root-test ./test`), so
  `test/security-properties.test.ts`, and anything added beside it, runs in the
  `Unit & Integration Tests` job on every PR targeting `main`.

  The workspace and root suites use `scripts/test-suite.mjs`; the mail and
  GitHub-review plugins use their own launchers. All produce the required
  reports and logs: bun's JUnit report at a known path per suite
  (`test-reports/<suite>.xml`, the record the guard reads) and the suite's
  console output beside it (`test-reports/<suite>.log`, the CI record). Each
  launcher deletes its own suite's report and log BEFORE that suite starts, so a
  file left by an earlier step or run cannot stand in for this one. The guard,
  `scripts/check-test-reports.mjs`, then reads every required report, collects
  the test files those reports show executed, discovers the test files on disk
  (every form bun discovers), and fails naming each discovered file that no
  report shows executed. It fails CLOSED: a required report that is missing,
  unreadable or empty fails the build, so a suite that never ran cannot read as
  a suite that covered everything. Discovery fails closed too: any directory it
  cannot read, including one that disappears mid-walk and a missing repository
  root, fails the guard instead of shrinking the set of test files it checks.

  The guard is its own step, the LAST step of the job, with `if: always()`: a
  suite step that fails does not skip it, and it is not a clause of any suite,
  so dropping a suite from the wiring cannot take the guard down with it. It
  measures what ran from the reports; it does not infer coverage from the
  workflow's wiring.

  bun's JUnit reporter omits a file with ZERO test cases (measured on the pinned
  bun 1.3.10: such a file appears in no `<testsuite>` and no `<testcase>`, though
  bun did execute it and counts it in "Ran N tests across M files"). Such a file
  is named by no report, so the guard fails on it and the failure says how to
  register a case — `test.skip` or `test.todo` for a placeholder, `describe.if` or
  `test.skipIf` for a platform-only file, so its cases show as skipped. The
  executed files come from the reports and nothing else: a test that PRINTS a
  path-shaped line cannot add a file to the set.

  (Refs #411)
