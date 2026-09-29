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

  The control is HOME redirection plus an allowlisted environment, applied at
  launch time in one shared place (`scripts/test-home-guard.mjs`). Every lane of
  `bun run test` runs through `scripts/test-suite.mjs`, which creates a fresh
  throwaway root and gives the child its whole environment: `HOME` and
  `TPS_TEST_ROOT` at the root, `TMPDIR`/`TMP`/`TEMP` and bun's transpiler cache
  inside it, and only these inherited variables — `PATH`, the locale
  (`LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, `LC_MESSAGES`),
  `TERM`, `NO_COLOR`, `FORCE_COLOR`, `CI` and `GITHUB_ACTIONS`, each only when
  its value holds no `/` (PATH excepted). Every other inherited variable is
  dropped, including ones nobody has named yet; the launcher prints the dropped
  names, never their values. A preload (`bun --preload`, and the `bunfig.toml`
  preloads at the repo root and in `packages/agent`, `packages/cli` and
  `packages/pi-tps-mail`) aborts the run before any test module loads unless
  `os.homedir()` is inside `TPS_TEST_ROOT`, the root is not and does not
  contain the account's home, and the root is one a launcher made (its marker
  matches `TPS_TEST_ROOT_TOKEN`). So a bare `bun test` — including one run with
  `TPS_TEST_ROOT=$HOME` — aborts by name. This is a launch-time check, not an
  OS boundary: a caller who forges the launcher's marker and token, or code
  that ignores HOME, can still reach the real home; the OS-enforced boundary is
  tracked in #434.

  Before creating or deleting anything, each launcher refuses a suite name that
  is not a plain file-name token (`[A-Za-z0-9._-]`, no `..`), a temp dir inside
  an operator home, and a report dir or report/log/seal path — the default
  `test-reports/` included — that resolves inside `~/.tps`, `~/.flair`,
  `~/agents` or `~/.config` or is a symlink; the seal path is checked again
  before the seal is written. The Docker `attested` service runs its targeted
  files through the launcher, with its report on the container's writable
  tmpfs. The `openclaw-tps-mail` plugin's launcher (which runs only inside this
  monorepo) uses the same shared helper for its environment, destination checks
  and snapshot, and its preload applies the same root check.

  Each launcher also takes a metadata snapshot of the `~/.tps` under the HOME it
  runs under — path, size, mtime, ctime and inode, never contents — before and
  after the lane, and fails the lane on a recorded metadata difference at the
  end. It is a diagnostic, not a boundary: an entry it cannot stat or list, or a
  change that leaves every recorded signature as it was, can be missed, and it
  does not see reads, writes outside `~/.tps`, or a transient write gone by the
  end (a `~/.tps` created and removed again within the run).

  The launcher process itself runs under the caller's environment: only its
  child gets the allowlisted one. A launcher started under bun (rather than
  node, which `bun run test` uses) may write bun's own transpiler cache under
  the caller's `XDG_CACHE_HOME` before any of this runs.

  A CI step runs the suite with `HOME` pointed at an empty directory and asserts
  that directory still has no `.tps` afterwards.

  (Refs #430)
