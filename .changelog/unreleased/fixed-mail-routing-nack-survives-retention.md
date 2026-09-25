- **An owed nack survives the retention sweep, and a failed `nackSentAt` write is logged by name (cli#389 round 11).**

  Two defects around the debt that keeps a nack mail owed.

  **Retention could delete an owed nack.** Startup ran the retention sweep
  BEFORE owed-nack recovery, and the sweep deleted an aged `failed` record
  without asking whether its nack mail was still owed — so a record that owed
  the sender a mail was swept the moment it aged past the window, and recovery
  then had nothing left to retry. Two changes: the sweep never removes a record
  carrying `nackPending` with no `nackSentAt` while it is inside the hold
  window, and the count of those held records is reported in its result; and
  startup TRIES an owed nack first, so a debt it CAN discharge is discharged
  before any retention decision reads the store. A debt recovery cannot
  discharge — no route, or a failed write — simply stays, and the sweep HOLDS
  it, whichever of the two runs first. The hold is on the debt, not on the
  record: once the debt is discharged the record is ordinary and ages out
  normally.

  **A failed `nackSentAt` write is logged by name.** The mail may already have
  left, but the record still owes it (`nackPending` stays), so a later start may
  hand it over again. That write failure is now logged
  (`obligation-write-failed`, naming the inbound) instead of being swallowed by
  the boolean return, and the caller says which of the two happened.

  The README and the changelog fragments now say only what the code guarantees:
  an owed nack is retried on a later start once the store can be written, an
  obligation whose store cannot be written resolves once it can, and
  `nackSentAt` is recorded when that write succeeds — otherwise the nack may
  repeat. "Never zero times", and resolutions promised for "the next start" or
  "at its deadline" whatever the store does, are gone. (The hold itself is
  bounded by age in round 12; see fixed-mail-routing-nack-retry-and-hold.md.)

  (Refs #389)
