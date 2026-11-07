- **The release-age gate checks tracked npm lockfiles (Closes #797).**
  It ages npm entries by canonical registry tarball URL, or recorded name@version
  without `resolved`, regardless of `inBundle`. It refuses versionless entries,
  URL/name/version disagreement, non-canonical registry URLs (including query
  strings and encoded scopes), and git URLs. Root, link and local entries are
  skipped. The workflow guard accepts raw `npm ci` without `--prefix` or lockfile writes,
  using the step/default directory with at most one leading literal
  `cd <relative path> &&`, or the tracked-lock helper with a literal relative
  fixture directory. Other shapes are refused. The helper requires `sfw`, a
  tracked lock and a byte-identical lock after installation. The guard inspects
  `npm ci` written directly in workflow `run:` steps; installs inside other
  script files or composite actions are not inspected.
