- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. The workflow guard flags physical `run:` lines when lowercasing and
  deleting backslashes and quotes reveals `npm`. A flagged block must match a
  complete block pinned in the guard or use a tracked-lock helper call or bounded
  global install shape without backticks, `$(` or multiline quotes. Refusals name
  the workflow, job, step and physical line. Variable or substitution indirection
  such as `n${x}pm` and `$(printf n)pm` is outside this spelling check.
  Helper steps allow `set -euo pipefail`, allowlisted quoted assignments with
  lowercase names, the literal heartbeat pin substitution, helper calls and
  `GITHUB_ENV` echoes. Other helper-step lines are refused.
  The helper reads the manifest and lock from `GITHUB_SHA` under GitHub Actions
  (validated as 40 hex characters), or `HEAD` locally. Prefix mode requires an
  absent or empty prefix and copies those bytes there. In-place mode refuses a
  shrinkwrap and verifies working manifest and lock bytes before installing.
  Both modes compare the installed lock against the saved revision bytes afterward.
  npm configuration is not checked (#837).
  The guard inspects workflow `run:` steps and the scripts and local composite actions those steps invoke by a literal path; installs inside other script files are not inspected.
