- **The root `test/` directory now runs in CI, and a test file no suite runs fails the build (cli#411).**

  `test/security-properties.test.ts` asserted the office supervisor's proxy-socket
  check, fail-closed secrets gate, signal fan-out and launch properties, and
  nothing ran it: the root `test` script walked `packages/agent`, `packages/cli`
  and `packages/pi-tps-mail` only, and no workflow step invoked the root
  directory, so every one of those properties was checked nowhere — a regression
  in any of them would have merged green. The root `test` script now ends with
  `bun test ./test`, so that file, and anything added beside it, runs in the
  `Unit & Integration Tests` job on every PR.

  `packages/cli/test/test-coverage.test.ts` keeps it that way. It walks the tree
  for `*.test.ts` / `*.spec.ts` / `*_test.ts` files, derives the directories a
  suite runs from the root `test` script and from the workflow step that runs the
  plugin's isolated launcher, and fails naming every file outside them — so a
  test that no suite runs cannot land unnoticed again, whether it is new or
  became uncovered because a step was dropped from the wiring. The wiring is
  itself asserted, by an exact string in the file that wires each suite, so
  removing a suite fails the guard instead of silently orphaning its files.

  It lives in the CLI suite rather than in the root directory it polices: a guard
  inside `test/` would be run only because of the wiring it checks, so deleting
  that clause from the root `test` script would disarm it silently.

  (Refs #411)
