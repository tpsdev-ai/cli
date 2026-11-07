- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. The workflow guard accepts raw `npm ci` without `--prefix` or lockfile writes,
  using the step/default directory with at most one leading literal
  `cd <relative path> &&`, or the tracked-lock helper with a literal relative
  fixture directory. Helper steps allow `set -euo pipefail`, allowlisted quoted
  assignments with lowercase names, literal `node scripts/heartbeat-real-openclaw-lane.mjs --pin` substitutions, helper calls and `GITHUB_ENV`
  echoes. Other shapes are refused. The helper requires `sfw`, copies the package
  and lock from `GITHUB_SHA` under GitHub Actions (validated as 40 hex characters),
  or `HEAD` locally, and compares the copied `package-lock.json` with the committed bytes.
  The gate refuses tracked `npm-shrinkwrap.json` files; the helper refuses non-empty prefixes. The guard inspects
  `npm ci` written directly in workflow `run:` steps; installs inside other
  script files or composite actions are not inspected.
