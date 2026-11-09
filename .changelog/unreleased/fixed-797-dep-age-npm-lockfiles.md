- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. Each workflow `run:` block is split into physical lines. Every line
  containing `npm` anywhere, in any case, must, after trimming, equal
  exactly one of: a helper call to `scripts/npm-ci-tracked-lock.sh` with a
  literal tracked directory and literal `--via npm` or `--via sfw`; `npm install
  -g|--global <name>@<MAJOR.MINOR.PATCH>`, where each part is `0` or
  `[1-9][0-9]{0,8}`, with an optional literal registry URL with a non-empty host; or an
  exact-line allowlist entry for a real workflow line. Other
  lines containing `npm` are refused with their workflow, job, step and physical line.
  Commands named entirely through variables with no `npm` characters on their line are outside this check.
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
