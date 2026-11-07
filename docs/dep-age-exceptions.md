# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` checks external versions in `bun.lock` and tracked
`package-lock.json` files against `[install] minimumReleaseAge` in `bunfig.toml`.
For npm entries, it ages the package identified by a canonical registry tarball
URL, or recorded name@version without `resolved`, regardless of `inBundle`.
Versionless entries, URL/name/version disagreement, non-canonical registry URLs
(including query strings and encoded scopes), and git URLs are refused. The root,
`link: true`, and local `file:`/`workspace:` entries are skipped.
The tracked npm lockfiles are:

- `plugins/openclaw-github-review/package-lock.json`
- `plugins/openclaw-tps-mail/package-lock.json`
- `test/fixtures/heartbeat-openclaw/package-lock.json`

The gate lists them with `git ls-files`, so a new tracked lockfile is read
without editing a list.

Add one line per exception under the `## Exceptions` heading below, in this
exact shape:

```
- name@version | expires:YYYY-MM-DD | reason: why this version is needed now
```

- `name@version` must use valid semver and match a resolution in `bun.lock` or a
  tracked `package-lock.json` byte for byte
  (a scoped name keeps its `@scope/`, so `@scope/pkg@1.2.3`).
- `expires` is a real calendar date, `YYYY-MM-DD`, and is inclusive: the entry
  holds through the end of that day, UTC. It is a deadline to remove the
  exception (pin or upgrade to an aged version, or let the package bake).
- `reason` is free text saying why the fresh version cannot wait.

Everything above the heading is documentation. Every non-blank line under the
heading must be an entry; an entry that is undated, has an impossible or past
date, has no reason, uses invalid semver, or is absent from every lockfile fails the gate (exit 2).

## Exceptions
