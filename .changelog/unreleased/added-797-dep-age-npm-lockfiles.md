- **The release-age gate checks tracked `package-lock.json` files (Closes #797).**
  It requires a v2 or v3 npm lockfile and ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and percent-encoded path components), and git URLs. Root, link and unencoded local entries are
  skipped. CI installs tracked npm lockfiles through a helper that reads the manifest and lock from `GITHUB_SHA`
  under GitHub Actions (validated as 40 hex characters), or `HEAD` locally, and compares the installed lock against
  those bytes afterward.
