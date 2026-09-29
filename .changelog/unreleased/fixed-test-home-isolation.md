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

  The control is HOME redirection plus a sanitized environment, applied at
  launch time in one shared place (`scripts/test-home-guard.mjs`). Every lane of
  `bun run test` runs through `scripts/test-suite.mjs`, which creates a
  throwaway root, points the child's `HOME` and `TPS_TEST_ROOT` at it, drops
  every inherited variable that routes a path around HOME (`XDG_CONFIG_HOME`
  and the other XDG base dirs, `TPS_*`, `FLAIR_*`, `BOB_*`, `OPENCLAW_*`,
  `CODEX_HOME`, `PI_CODING_AGENT_DIR`, …), and preloads (`bun --preload`) a
  guard that ABORTS the run unless `os.homedir()` resolves inside that root.
  Before creating or deleting anything, the launcher refuses a temp dir
  (`TMPDIR`) or `TPS_TEST_REPORT_DIR` that resolves inside `~/.tps`,
  `~/.flair`, `~/agents` or `~/.config`. `bunfig.toml` preloads at the repo root
  and in `packages/agent`, `packages/cli` and `packages/pi-tps-mail` apply the
  same guard to a bare `bun test`, which now aborts by name. The Docker
  `attested` service runs its targeted files through the launcher, with its
  report on the container's writable tmpfs. The `openclaw-tps-mail` plugin's
  launcher (which runs only inside this monorepo) applies the same environment
  sanitizing, destination check and snapshot beside its existing HOME override
  and bunfig preload.

  Each launcher also takes a metadata snapshot of the `~/.tps` under the HOME it
  runs under — path, size, mtime, ctime and inode, never contents — before and
  after the lane, and fails the lane when a change persisted to the end of the
  run (an entry added or removed, resized, rewritten, or replaced). It is a
  diagnostic, not a boundary: it does not see reads, writes outside `~/.tps`, or
  a `~/.tps` created and removed again within the run.

  A CI step runs the suite with `HOME` pointed at an empty directory and asserts
  that directory still has no `.tps` afterwards.

  (Refs #430)
