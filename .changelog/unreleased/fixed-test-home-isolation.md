- **`bun run test` runs every lane under a throwaway HOME with an allowlisted environment, and fails a lane that changes the caller's `~/.tps` metadata (cli#430).**

  The monorepo and openclaw-tps-mail test launchers use isolated homes,
  restrict inherited environment variables, validate write destinations and
  fail a lane on a detected change to the caller's `~/.tps` metadata. The
  openclaw-github-review launcher gives its suite an isolated HOME, and its
  preload aborts a run outside that root; the environment allowlist,
  destination checks, `--reporter-outfile` refusal and `~/.tps` snapshot below
  do not apply to it.

  The control is HOME redirection plus an allowlisted environment, applied at
  launch time in one shared place (`scripts/test-home-guard.mjs`), because under
  bun `os.homedir()` keeps the HOME it read at first call. Every lane of
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
  OS boundary; the OS-enforced boundary is tracked in #434.

  Before creating or deleting anything, the monorepo launcher refuses a suite
  name that is not a plain file-name token (`[A-Za-z0-9._-]`, no `..`), a temp
  dir inside an operator home, a report directory that is or contains an
  operator home (`TPS_TEST_REPORT_DIR=$HOME`, or `/`), and a report directory
  that resolves inside `~/.tps`, `~/.flair`, `~/agents` or `~/.config` — the
  default `test-reports/` included. Report, log and seal files that are
  symlinks are also refused; the seal path is checked again before the seal is
  written. The monorepo and openclaw-tps-mail launchers also refuse a
  caller-supplied `--reporter-outfile` argument, owning the report destination.
  The Docker `attested` service runs its targeted files through the launcher,
  with its report on the container's writable tmpfs. The `openclaw-tps-mail`
  plugin's launcher (which runs only inside this monorepo) uses the same shared
  helper for its environment, destination checks and snapshot, and its preload
  applies the same root check.

  The monorepo and openclaw-tps-mail launchers also take a metadata snapshot of
  the `~/.tps` under the HOME they run under — path, size, mtime, ctime and
  inode, never contents — before and after the lane, and fail the lane on a
  recorded metadata difference at the end. It is a diagnostic, not a boundary:
  an entry it cannot stat or list, or a change that leaves every recorded
  signature as it was, can be missed, and it does not see reads, writes outside
  `~/.tps`, or a transient write gone by the end (a `~/.tps` created and removed
  again within the run).

  The launcher process itself runs under the caller's environment: only its
  child gets the allowlisted one. A launcher started under bun (rather than
  node, which `bun run test` uses) may write bun's own transpiler cache under
  the caller's `XDG_CACHE_HOME` before any of this runs.

  A CI step runs the suite with `HOME` pointed at an empty directory and asserts
  that directory still has no `.tps` afterwards.

  `tps auth` now builds its `~/.tps/auth` path each time it is used, instead of
  once when the module loads. Every home-relative path in `tps auth` goes
  through one helper, `homeDir()`: `HOME` when it is set and not empty,
  otherwise `os.homedir()`, read on every call. Nothing in the CLI changes HOME
  while it runs, so a CLI run uses the same paths as before; in the test suite,
  each test's `tps auth` calls use that test's home.

  (Refs #430)
