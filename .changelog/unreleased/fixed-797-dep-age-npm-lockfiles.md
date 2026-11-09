- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. A workflow `run:` line is joined with the next when it ends in a backslash.
  The gate finds the npm word and install subcommand after deleting quotes,
  backslashes and `$'` prefixes. It accepts a helper call to
  `scripts/npm-ci-tracked-lock.sh` with a literal tracked directory and literal
  `--via npm` or `--via sfw`, or a global tool install whose raw line is exactly
  `npm install -g|--global <name>@<exact-version>` with an optional literal
  `--registry=https://...`; that line may not contain `$`, a backtick, a quote,
  `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}` or `\`. Other npm install lines
  are refused. A non-comment line that carries a backtick and names npm is
  refused, except an `echo "..."` line whose backticks are all escaped and which
  has no `$(`; whole-line shell comments are not inspected.
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
