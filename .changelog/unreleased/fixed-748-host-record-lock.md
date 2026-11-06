- **`tps office kill` and the host connection writer share one lock per host state record.** `office kill`
  holds it across its final read and removal, `writeHostState` takes it for each write, and the
  connector's shutdown removes the record under it only while the record still names its own process.
  Once shutdown begins the connector's pending and late writes are suppressed under the same lock, so a
  connection or callback that settles afterwards does not recreate the record; a removal failure other
  than a missing file is rethrown.
