# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` fails when `bun.lock` resolves an external package
version published less than `[install] minimumReleaseAge` seconds ago (7 days,
from `bunfig.toml`). This file is the only way to let one through.

Add one line per exception under the `## Exceptions` heading below, in this
exact shape:

```
- name@version | expires:YYYY-MM-DD | reason: why this version is needed now
```

- `name@version` must match the resolved version in `bun.lock` byte for byte
  (a scoped name keeps its `@scope/`, so `@scope/pkg@1.2.3`).
- `expires` is a real calendar date, `YYYY-MM-DD`, and is inclusive: the entry
  holds through the end of that day, UTC. It is a deadline to remove the
  exception (pin, upgrade or let the package bake), not a renewal reminder.
- `reason` is free text saying why the fresh version cannot wait.

Everything above the heading is documentation. Every non-blank line under the
heading must be an entry; an entry that is undated, has an impossible or past
date, or has no reason fails the gate (exit 2) rather than being ignored, so a
stale exemption cannot linger.

There are no exceptions today.

## Exceptions
