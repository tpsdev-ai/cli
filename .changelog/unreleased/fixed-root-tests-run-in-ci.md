- **The root `test/` directory now runs in CI, with a guard that compares discovered test files to the suites' JUnit reports (cli#411).**

  The root `test` script runs `./test` through the suite runner
  (`node scripts/test-suite.mjs root-test ./test`), so
  `test/security-properties.test.ts` runs in the `Unit & Integration Tests` job
  for PRs targeting `main`. The job's last step, `scripts/check-test-reports.mjs`,
  compares the test files discovered on disk with the file names in the suites'
  sealed JUnit reports, and fails on a missing required report and on a
  discovered file that no report names. bun's JUnit reporter omits a file with
  zero test cases, so a placeholder or platform-only file needs a registered case
  (`test.skip`, `test.todo`, `describe.if` or `test.skipIf`).

  (Refs #411)
