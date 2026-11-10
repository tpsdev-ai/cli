# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` checks external versions in `bun.lock` and tracked
`package-lock.json` files against `[install] minimumReleaseAge` in `bunfig.toml`.
For npm entries, it ages the package identified by a canonical registry tarball
URL, or recorded name@version without `resolved`, regardless of `inBundle`.
Versionless entries, URL/name/version disagreement, non-canonical registry URLs
(including query strings and percent-encoded path components), and git URLs are refused. The root,
`link: true`, and unencoded local `file:`/`workspace:` entries are skipped.
A v2 or v3 npm lockfile is required. The tracked `package-lock.json` files are:

- `plugins/openclaw-github-review/package-lock.json`
- `plugins/openclaw-tps-mail/package-lock.json`
- `test/fixtures/heartbeat-openclaw/package-lock.json`

The gate lists them with `git ls-files`, so a new tracked `package-lock.json` is read
without editing a list.

Each workflow `run:` block is split into physical lines. A line is flagged if
lowercasing and deleting backslashes and quotes reveals `npm`. A flagged block
must match a complete block pinned in the guard, after trailing-newline
normalization, or use these shapes without backticks, `$(` or multiline quotes:

- a helper call to `scripts/npm-ci-tracked-lock.sh` with a literal relative
  tracked directory and literal `--via npm` or `--via sfw`;
- `npm install -g` or `--global` followed by `<name>@<MAJOR.MINOR.PATCH>`, where
  each part is `0` or `[1-9][0-9]{0,8}`, with an optional literal
  `--registry=https://<host>[/<path>]` with a non-empty host; that line may not contain `$`, a backtick,
  a quote, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}` or `\`.

Refusals name the workflow, job, step and physical line. Variable or substitution
indirection such as `n${x}pm` and `$(printf n)pm` is outside this spelling check.
The guard follows repository scripts a workflow invokes by a literal path,
recursively, and local composite actions (`uses: ./...`). In a followed shell
script, a logical line (continuations joined, word-boundary comments stripped,
here-document bodies kept) is an install when, after lowercasing and deleting
backslashes and quotes, it contains `npx` as a word, or `npm` as a word followed
later by `ci`, `install`, `i`, `add`, `exec` or `x`. An install must use the
tracked-lock helper, a bounded global install, or bind to a tracked lockfile,
and `--no-package-lock` is refused. `scripts/npm-ci-tracked-lock.sh` is the
approved install implementation: its own lines are not screened by that
classifier, though its invocations are followed. An interpreter invocation is
followed when its script argument resolves to a repository file; a computed,
external, `-c`/`-s` or here-document-to-shell invocation is refused unless it is
on the reviewed allowlist, whose entries pin the assignment text and target.
Installs inside followed JavaScript or TypeScript scripts, and node `-e`/`-p`
or node here-document payloads, are not inspected; their here-document bodies
are still install-screened. Helper
steps allow
`set -euo pipefail`, allowlisted quoted assignments with lowercase names (including
literal `node scripts/heartbeat-real-openclaw-lane.mjs --pin` substitutions), helper
calls and `GITHUB_ENV` echoes. Other helper-step lines are refused. The helper
limits install flags to `--ignore-scripts`, `--no-audit` and `--no-fund`.

The gate refuses tracked `npm-shrinkwrap.json` files anywhere in the repository.
The helper selects `GITHUB_SHA` under GitHub Actions (required to be 40 hex
characters), or `HEAD` locally, and logs that revision. It requires the selected
installer and reads the tracked directory's manifest and lock from that revision.
In prefix mode it requires an absent or empty prefix and copies those bytes there.
In `--in-place` mode it refuses `npm-shrinkwrap.json` in the install directory,
including untracked files, and verifies that the working `package-lock.json` and
`package.json` are byte-identical to the selected revision before installing there.
Both modes compare the installed directory's `package-lock.json` against the saved
revision bytes after the install. npm configuration is not checked (#837).
The heartbeat uses `--via sfw`; plugin installs use `--via npm`.
#818 defers hermetic local-registry adversarial coverage; the heartbeat CI step
already runs real npm through `sfw`.

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
date, has no reason, uses invalid semver, or is absent from `bun.lock` and the tracked `package-lock.json` files fails the gate (exit 2).

## Workspace patterns

When `minimumReleaseAgeExcludes` is non-empty, the gate uses its local workspace
model of the root `package.json` `workspaces` patterns to decide which manifests
an exclusion applies to. It refuses these shapes:

- a `!`-negated pattern, because Bun 1.3.10 and 1.4.4 resolve some negated
  spellings to different workspace sets (with `["!packages/x", "packages/*"]`,
  1.3.10 installs `packages/x` and `packages/y`, and 1.4.4 installs only
  `packages/y`);
- a pattern mixing a `{...}` brace group with a `[...]` character class; the
  unbalanced spelling `packages/{a,[b}c]` is version-dependent too (1.3.10
  installs `packages/a`, 1.4.4 installs nothing);
- a brace group with an empty or `.` alternative at any nesting level, such as
  `packages/{a,}` or `packages/{a,{b,}}`; Bun applies only `packages/a` for
  `packages/{a,}`, while the local workspace model would also apply the parent
  directory `packages`;
- a pattern using glob syntax the gate does not model: a `(`, `)` or `|`
  outside a `[...]` class, an extended glob (`?(...)`, `*(...)`, `+(...)`,
  `@(...)`, `!(...)`), or any `..` inside a brace group (such as
  `packages/{1..3}` or `packages/{..,a}`). Bun 1.3.10 matches
  neither `packages/+([ab])` nor `packages/@(a|b)` and installs no workspace
  (`packages/@(a|b)` exits with `Workspace not found`), while 1.4.4 installs
  the matching directories.

List only the directories to include.

## Exceptions
