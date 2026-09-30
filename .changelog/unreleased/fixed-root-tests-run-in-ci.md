- **The root `test/` directory now runs in CI, and a report guard checks discovered test files against the suites' reports (cli#411).**

  The root `test` script runs the root `./test` directory through the suite
  runner (`node scripts/test-suite.mjs root-test ./test`), so
  `test/security-properties.test.ts`, and anything added beside it, runs in the
  `Unit & Integration Tests` job for PRs targeting `main`. That job runs after a
  successful build, and the root suite runs after the preceding suites succeed.

  The workspace and root suites use `scripts/test-suite.mjs`; the mail and
  GitHub-review plugins use their own launchers. A suite that reaches its report
  setup writes bun's JUnit report (`test-reports/<suite>.xml`) and its console
  log (`test-reports/<suite>.log`); its launcher removes that suite's earlier
  report and log at that point.

  The guard, `scripts/check-test-reports.mjs`, runs as the last step of the job
  with `if: always()`. It fails on a required report that is missing, invalid or
  not sealed, and it compares the test files discovered on disk (every form bun
  discovers) with the file names in the accepted reports, failing on each
  discovered file that no report names. Discovery that cannot read a directory,
  or finds no repository root, fails the guard. The guard checks reports and
  their seals; it does not check which run produced them.

  bun's JUnit reporter omits a file with zero test cases (measured on the pinned
  bun 1.3.10), so such a file is named by no report and the guard fails on it,
  saying how to register a case: `test.skip` or `test.todo` for a placeholder,
  `describe.if` or `test.skipIf` for a platform-only file. The set of executed
  files comes from the reports only; a test that prints a path-shaped line does
  not add a file to it.

  (Refs #411)
