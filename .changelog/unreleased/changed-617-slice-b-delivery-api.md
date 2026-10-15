- **MailClient gains a per-message delivery API; CLI mail presenters and actions decide a record's placement intent under the mailbox lock (Refs #617, slice b).**

  Nothing in the agent runtime calls the new API yet, so the agent event
  loop's delivery is unchanged until slice (c) wires it. `deliverNext()`
  commits one message and leaves its placement intent `in_progress`, held by
  a per-presentation claim; `completeDelivery()` removes the intent only for
  the hand-over it was given, while cur/ still holds the recorded file;
  `releaseDelivery()` ends a hand-over without completing it. A released (or
  abandoned) message is presented again by a later call, after its cur/ copy
  re-verifies, until it is completed or the liveness bound moves it to
  terminal `failed`: a presentation beyond the fifth, or a call that finds it
  unclaimed more than 24 hours after its first presentation. The payload is
  kept, and a log line names the mailbox, message ID and presentation count
  (a kill between the `failed` write and the line leaves no line). While a
  `placing` or `in_progress` placement is pending and cannot be presented now,
  `deliverNext()` returns a named deferral and commits no new mail. The
  mailbox path is resolved once, when the client is constructed.

  This changes behaviour now, outside the agent runtime: `recoverPromoted`,
  `tps mail ack` and `nack` (and `ackMessage` / `nackMessage`), and the
  OpenClaw mail plugin's ack and nack stamps refuse a cur/ record whose
  intent is `in_progress`, `failed` or `unknown`, or is another consumer's
  `placing` commit. `recoverPromoted` makes that decision under the mailbox
  lock after its verification and never quarantines such a record; ack, nack
  and the plugin's stamps check again under their own lock.
