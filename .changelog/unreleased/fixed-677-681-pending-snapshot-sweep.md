- **`tps agent start` sweeps pending launch snapshots, never attestation directories; the mailbox lock, outbox lock and `tps status` share one pid check (#677, #681).**

  A forced kill while a launch snapshot is pending can leave a
  `.pending-config-*` directory under `~/.tps/launch`. The next launch removes
  one whose owner record names a dead launcher, by the same pid and start-token
  rule as published snapshots, or that has no readable owner record and a
  directory mtime at least 24 hours old. One whose recorded launcher is still
  running is kept.

  The sweep selects only entries named `config-` or `.pending-config-` followed
  by exactly six letters or digits, so a launch's attestation directory in the
  same place, named after its agent id, is never selected, including for an
  agent whose id is `config` or starts with `config-`.

  The `@tpsdev-ai/agent` mailbox lock, the cli's outbox lock and `tps status`
  check a recorded pid with one rule: a pid that is not an integer from 1 to
  2147483647 is never treated as a live process, and a process that exists under
  another user is. `tps status` reported a process that exists under another
  user as a zombie.
