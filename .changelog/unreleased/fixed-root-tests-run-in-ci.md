- **The root `test/` directory now runs in CI, and a test file no suite runs fails the build (cli#411).**

  `test/security-properties.test.ts` asserted the office supervisor's proxy-socket
  check, fail-closed secrets gate, signal fan-out and launch properties, and
  nothing ran it: the root `test` script walked `packages/agent`, `packages/cli`
  and `packages/pi-tps-mail` only, and no workflow step invoked the root
  directory, so every one of those properties was checked nowhere — a regression
  in any of them would have merged green. The root `test` script now runs the
  root `./test` directory through the suite runner
  (`node scripts/test-suite.mjs root-test ./test`), so that file, and anything
  added beside it, runs in the `Unit & Integration Tests` job on every PR.

  What keeps it that way MEASURES what ran instead of reading the wiring. Every
  suite the job runs, except the plugin's, is launched through
  `scripts/test-suite.mjs`, which writes
  bun's JUnit report to a known path per suite (`test-reports/<suite>.xml`, the
  record the guard reads) and saves the suite's console output beside it
  (`test-reports/<suite>.log`, the CI record); the plugin's launcher
  (`plugins/openclaw-tps-mail/scripts/run-tests.mjs`) sets the same flags for its
  own run. Each launcher deletes its own suite's report and log BEFORE that suite
  starts, so a file left by an earlier step or run cannot stand in for this one.
  The guard, `scripts/check-test-reports.mjs`, then reads every required report,
  collects the test files those reports show executed, discovers the test files
  on disk (every form bun discovers), and fails naming each discovered file that
  no report shows executed. It fails CLOSED: a required report that is missing,
  unreadable or empty fails the build, so a suite that never ran cannot read as a
  suite that covered everything. Discovery fails closed too: any directory it
  cannot read, including one that disappears mid-walk and a missing repository
  root, fails the guard instead of shrinking the set of test files it checks.

  The guard is its own step, and now the LAST step of the job with
  `if: always()`: a suite step that fails does not skip it, and it is not a
  clause of any suite, so dropping a suite from the wiring cannot take the guard
  down with it. Its predecessor INFERRED coverage from the wiring — it parsed the
  root `test` script and the workflow's `run:` steps as shell programs — and so
  reported coverage for commands CI never runs: a `bun test` behind a `#` shell
  comment, inside quotes, behind `false &&`, piped through `xargs`, in a step
  carrying `if: false`, behind an `env X=1` prefix, or with `--timeout 5000` read
  as a path. Each was one more construct to teach an interpreter, and there is
  always another, so the guard no longer infers — it measures.

  bun's JUnit reporter omits a file with ZERO test cases (measured on the pinned
  bun 1.3.10: such a file appears in no `<testsuite>` and no `<testcase>`, though
  bun did execute it and counts it in "Ran N tests across M files"). Such a file
  is named by no report, so the guard fails on it and the failure says how to
  register a case — `test.skip` or `test.todo` for a placeholder, `describe.if` or
  `test.skipIf` for a platform-only file, so its cases show as skipped. The
  executed files come from the reports and nothing else: a test that PRINTS a
  path-shaped line cannot add a file to the set.

  (Refs #411)
