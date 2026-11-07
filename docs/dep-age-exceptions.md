# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` checks external versions in `bun.lock` and tracked
`package-lock.json` files against `[install] minimumReleaseAge` in `bunfig.toml`.
For npm entries, it ages the package identified by a canonical registry tarball
URL, or recorded name@version without `resolved`, regardless of `inBundle`.
Versionless entries, URL/name/version disagreement, non-canonical registry URLs
(including query strings and percent-encoded path components), and git URLs are refused. The root,
`link: true`, and unencoded local `file:`/`workspace:` entries are skipped.
A v2 or v3 npm lockfile is required. The tracked npm lockfiles are:

- `plugins/openclaw-github-review/package-lock.json`
- `plugins/openclaw-tps-mail/package-lock.json`
- `test/fixtures/heartbeat-openclaw/package-lock.json`

The gate lists them with `git ls-files`, so a new tracked lockfile is read
without editing a list.

The workflow guard inspects `npm ci` written directly in workflow `run:` steps
and calls to `scripts/npm-ci-tracked-lock.sh`; installs inside other script files
or composite actions are not inspected. It accepts raw `npm ci` (optionally
behind `sfw`) without `--prefix` or lockfile writes in the step, using the
step/default working directory and at most one leading literal
`cd <relative path> &&`. The other accepted shape is the helper with a literal
relative fixture directory whose `package-lock.json` is tracked. Helper steps
allow `set -euo pipefail`, allowlisted quoted assignments with lowercase names (including literal
`node scripts/<file>.mjs` substitutions), helper calls and `GITHUB_ENV` echoes.
Other command shapes are refused. The raw guard and helper limit install flags to `--ignore-scripts`,
`--no-audit` and `--no-fund`.

The helper requires `sfw`, reads the fixture's package and lock from `HEAD`,
refuses if either path is absent there, copies those committed bytes into the
prefix, and runs `sfw npm ci --prefix` there. After the install, `cmp` must find
the prefix lock byte-identical to the saved committed lock.

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
