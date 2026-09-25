- **An owed-nack retry is bounded and off the startup path, and the owed-nack hold is bounded by age (cli#389 round 12).**

  Two defects in the round-10 durable nack, surfaced by review.

  **Owed-nack recovery must not stall startup.** Startup AWAITED each owed nack
  in turn, and connecting to an unreachable remote branch has no
  application-level timeout — so one dead branch could stall recovery for this
  agent and every later one. The retries now run in the BACKGROUND, each under an
  overall timeout spanning the connection AND the existing ACK wait; on expiry
  the transport is closed and the timeout is logged BY NAME
  (`nack-retry-timeout`). The retention sweep already HOLDS any record whose nack
  is owed, so recovery no longer needs to run before retention for correctness:
  the hold stays, the ordering dependency is gone.

  **The owed-nack hold needs a bound.** A sender with no route kept its `failed`
  record forever, so startup work and `nack-pending` log volume grew with those
  records. The hold is now bounded by AGE — a configurable multiple of
  `obligationRetentionDays` (key `obligationNackHoldMultiple`, default 4, i.e. 28
  days on the 7-day window). Past the bound the debt is abandoned: logged
  `nack-abandoned`, once, by name, and normal retention then applies.

  (Refs #389)
