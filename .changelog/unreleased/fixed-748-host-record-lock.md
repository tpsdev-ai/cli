- **`tps office kill` and the host connection writer share one lock per host state record.** `office kill`
  holds it across its final read and removal, `writeHostState` takes it for each write, and the
  connector's shutdown removes the record under it only while the record still names its own process.
  Once shutdown begins the connector's pending and late writes are suppressed under the same lock, so a
  connection or callback that settles afterwards does not recreate the record. The lock wait is bounded
  by its 5 s deadline plus the probes' own timeouts; a timeout names the lock path and a removal remedy,
  and other errors propagate. Shutdown keeps a record that is present but unreadable or not a valid host
  state record, and reports its path with the same removal remedy; any other removal failure than a
  missing file is rethrown.
