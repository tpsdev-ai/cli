- **MailClient adds a per-message delivery API; CLI recovery and actions guard placement phase (Refs #617, slice b).**

  Agent event-loop wiring is unchanged.

  Unresolved `placing`/`in_progress` work defers new commits. Active claims
  defer re-presentation. Released or abandoned claims may be presented again
  after verification and lock acquisition. Completion checks the issued token
  and recorded file identity. The mailbox path is resolved at construction.
  On later calls, an unclaimed `in_progress` intent becomes `failed` before
  a presentation beyond the fifth, or after the deadline of 24 hours from
  first presentation. The payload stays; a kill after the phase write can
  prevent its log line.

  CLI recovery dispatch claims, ack and nack check placement phase under the
  mailbox lock. The OpenClaw plugin guards its envelope-less verification
  branch and its ack/nack stamps too.
