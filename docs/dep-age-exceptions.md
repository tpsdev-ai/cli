# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` checks every external version in `bun.lock` against
`[install] minimumReleaseAge` in `bunfig.toml`.

Add one line per exception under the `## Exceptions` heading below, in this
exact shape:

```
- name@version | expires:YYYY-MM-DD | reason: why this version is needed now
```

- `name@version` must use valid semver and match a resolution in `bun.lock` byte for byte
  (a scoped name keeps its `@scope/`, so `@scope/pkg@1.2.3`).
- `expires` is a real calendar date, `YYYY-MM-DD`, and is inclusive: the entry
  holds through the end of that day, UTC. It is a deadline to remove the
  exception (pin or upgrade to an aged version, or let the package bake).
- `reason` is free text saying why the fresh version cannot wait.

Everything above the heading is documentation. Every non-blank line under the
heading must be an entry; an entry that is undated, has an impossible or past
date, has no reason, uses invalid semver, or is absent from `bun.lock` fails the gate (exit 2).

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
  `@(...)`, `!(...)`), or a brace range such as `{1..3}`. Bun 1.3.10 matches
  neither `packages/+([ab])` nor `packages/@(a|b)` and installs no workspace
  (`packages/@(a|b)` exits with `Workspace not found`), while 1.4.4 installs
  the matching directories.

List only the directories to include.

## Exceptions
