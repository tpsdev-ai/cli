- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. Each workflow `run:` block is split into physical lines; the gate does not
  join continuations, strip comments or track quote state. A physical line is
  npm-bearing when its normalized copy (quotes, backslashes and `$'` deleted)
  names npm and an install-subcommand token or an expanded subcommand, when a backtick
  appears on a line that names npm, when a line that names npm ends in a
  continuation backslash, or when the raw line names an install subcommand with npm inside a brace group. Every
  npm-bearing line must, after trimming leading and trailing whitespace, equal
  exactly one of: a helper call to `scripts/npm-ci-tracked-lock.sh` with a
  literal tracked directory and literal `--via npm` or `--via sfw`; `npm install
  -g|--global <name>@<MAJOR.MINOR.PATCH>`, where each part is `0` or
  `[1-9][0-9]{0,8}`, with an optional literal `--registry=https://...`; or an
  exact-line allowlist entry for a real line that cannot execute npm. Any other
  npm-bearing line is refused, naming the workflow, job, step and physical line.
  The match is conservative, not bash-equivalent: a command named entirely
  through variables with no literal npm token on the line is not detected.
  Helper steps allow `set -euo pipefail`, allowlisted quoted assignments with
  lowercase names, the literal heartbeat pin substitution, helper calls and
  `GITHUB_ENV` echoes. Other helper-step lines are refused.
  The helper reads the manifest and lock from `GITHUB_SHA` under GitHub Actions
  (validated as 40 hex characters), or `HEAD` locally. Prefix mode requires an
  absent or empty prefix and copies those bytes there. In-place mode refuses a
  shrinkwrap and verifies working manifest and lock bytes before installing.
  Both modes compare the installed lock against the saved revision bytes afterward.
  npm configuration is not checked (#837).
  The guard inspects workflow `run:` steps; installs inside other script files or
  composite actions are not inspected.
