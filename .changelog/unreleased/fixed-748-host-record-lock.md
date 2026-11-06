- **`tps office kill` and the host connection writer share one lock per host state record.** `office kill`
  holds it across its final read and removal; `writeHostState` takes it for each write.
  The connector's `stop()` removes a valid record under that lock only when it names its own process
  and branch. Writes after `stop()` begins are suppressed under the lock; a late connection skips writing.
  The lock wait is bounded by its 5 s deadline plus the probes' own timeouts; a timeout names the lock
  path and a removal remedy. `office kill` collects host-record lock failures and continues shutdown before
  exiting non-zero. After a connection attempt fails, the relay tries to close its channel before retry;
  a close that rejects is reported and retained for `stop()`. If a close still rejects at `stop()`, the record
  is kept and `stop()` rejects with its path. Stalled closes are not detected: the transports resolve after
  their own timeout (cli#774). Inbound host-record update failures report the record path and that message
  handling continues. Lock release is best effort: lock-directory removal errors are ignored, and the next
  acquirer reclaims a remaining lock only if its owner is provably dead. `stop()` keeps unreadable or invalid records
  and reports their path, instructing the operator to inspect the record and remove it if no connector
  for that host is running. Other removal failures except a missing file are rethrown.
  `tps office connect` awaits `stop()` on SIGINT and exits 1 if it rejects, reporting the failed disconnect.
  On SIGTERM the process exits without that cleanup; `office kill` sends it and attempts record removal after confirming exit.
