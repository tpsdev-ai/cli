- **`tps agent start` sweeps stale `.pending-config-*` launch directories, and the `@tpsdev-ai/agent` mailbox lock uses the launch sweep's pid check (#677, #681).**

  A forced kill while a launch snapshot is pending can leave a
  `.pending-config-*` directory under `~/.tps/launch`. The next launch removes
  one whose owner record names a dead launcher, by the same pid and start-token
  rule as published snapshots, or that has no readable owner record and a
  directory mtime at least 24 hours old. One whose recorded launcher is still
  running is kept.

  The `@tpsdev-ai/agent` mailbox lock's owner check uses the same pid rule: a
  recorded pid that is not an integer from 1 to 2147483647 is handled as an
  unreadable owner record (the lock is kept and acquisition times out), never as
  a live process.
