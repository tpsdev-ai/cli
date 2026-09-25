- **The root `test/` directory now runs in CI, and a test file no suite runs fails the build (cli#411).**

  `test/security-properties.test.ts` asserted the office supervisor's proxy-socket
  check, fail-closed secrets gate, signal fan-out and launch properties, and
  nothing ran it: the root `test` script walked `packages/agent`, `packages/cli`
  and `packages/pi-tps-mail` only, and no workflow step invoked the root
  directory, so every one of those properties was checked nowhere — a regression
  in any of them would have merged green. The root `test` script now ends with
  `bun test ./test`, so that file, and anything added beside it, runs in the
  `Unit & Integration Tests` job on every PR.

  `scripts/check-test-coverage.mjs` keeps it that way, as its OWN step of that
  job rather than as a test inside a suite. A guard that ran inside a suite could
  be disarmed by dropping that suite from the wiring — the exact failure it exits
  to catch — so it is a standalone script: dropping any suite clause leaves it
  running, and failing, naming what it lost.

  It reads the wiring rather than searching for text. The covered roots are
  derived from the root `test` script (`scripts.test`, and every script it calls,
  followed through `cd` and `bun run <name>`) and from the workflow's own steps,
  parsed as YAML, whose `run:` values are shell programs — so a clause moved into
  an unused script, or commented out in YAML or on a shell line, does not read as
  wired. The plugin's launcher (`plugins/openclaw-tps-mail/scripts/run-tests.mjs`)
  is read for the root IT runs, `bun test test/`, so the plugin's covered root is
  `plugins/openclaw-tps-mail/test` and a test file elsewhere in the plugin is
  reported as an orphan. Where a step or script names a test run but no root can
  be read from it — a launcher the guard cannot open, a `bun test` whose
  arguments are a variable — it fails and says so instead of widening the covered
  set, and it names every test file no suite runs.

  (Refs #411)
