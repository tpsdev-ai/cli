- **The cli test suite no longer writes into the operator's real `~/.tps` (cli#430).**

  Running the suite under a real HOME rewrote identity fixtures
  (`~/.tps/identity/key-test-ops36.*`, `test-bot-ops36.*`), appended
  register/unregister rows to `~/.tps/credentials/audit.log`, and created and
  removed `~/.tps/auth`, `~/.tps/agents` and `~/.tps/run` entries. On a host
  that runs production agents under the same user, a suite that resolves
  `~/.tps` from the real HOME can overwrite a real agent's key, mailbox or
  credential record. The root cause is that the suites resolve `~/.tps` from
  `os.homedir()`, and under bun `os.homedir()` caches the HOME it read at first
  call — so a test that set `process.env.HOME` to a temp dir still resolved the
  real home.

  The fix is at launch time, in one shared place. Every lane of `bun run test`
  runs through `scripts/test-suite.mjs`, which creates a throwaway root, points
  the child's `HOME` and `TPS_TEST_ROOT` at it, drops any ambient
  `TPS_MAIL_DIR`/`TPS_TEST_KEYS_DIR` so a real one cannot leak back in, and
  preloads (`bun --preload`) a guard that ABORTS the run unless `os.homedir()`
  resolves inside that root — so a forgotten test cannot reach the real HOME.
  `bunfig.toml` preloads in `packages/agent`, `packages/cli` and
  `packages/pi-tps-mail` apply the same guard to a bare `bun test` in those
  directories (mirroring the plugin's existing bunfig guard); the repo root has
  none, because the container `attested` lane runs a targeted `bun test` there
  against its own ephemeral HOME. The launcher also snapshots the real `~/.tps`
  before and after every lane (paths, sizes and mtimes only — never contents)
  and FAILS the lane if anything changed, catching a leak that hard-codes the
  real path. The `openclaw-tps-mail` plugin's self-contained launcher gets the
  same before/after snapshot beside its existing HOME override and bunfig
  preload.

  A CI step runs the suite with `HOME` pointed at an empty directory and asserts
  that directory still has no `.tps` afterwards.

  (Refs #430)
