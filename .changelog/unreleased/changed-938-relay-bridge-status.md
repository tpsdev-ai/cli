- **`tps mail relay stop` exits non-zero when it refuses an unreadable or unverified pid record, and `tps bridge status --json` adds a `records` array.**

  Stop prints the record's guidance, signals no process and exits non-zero.
  Bridge status `--json` keeps the existing `running`, `pid`, `port`, `adapter`
  and `bridges` fields unchanged, and adds `records` with one
  `{ adapter, path, state }` entry per pid record; `state` is the record kind
  (`running`, `invalid`, `stale`, `unverified`, `unreadable`), a record whose
  kind carries a `pid` includes it, and an `unreadable` record includes its
  `reason` when it has one.
