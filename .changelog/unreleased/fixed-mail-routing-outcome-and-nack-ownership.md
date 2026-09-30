- **A reply obligation is settled from its persisted delivery state by one verb, which also owns the nack mail; a closed obligation refuses a late final (cli#389).**

  **Delivery state is persisted.** The obligation record is written
  `delivering` before the delivery call and `posted` when the call returns, so
  the turn, the deadline timer and restart recovery all read the same state,
  and one verb settles the obligation from it. Persisted delivery state
  prevents uncertain delivery and evidence-maintenance errors from becoming
  failure verdicts; attributable quarantine remains a definitive failure.

  **Outcomes.** Receipt evidence gives `acked`. A committed record
  (`delivering` or `posted`) with no evidence at its deadline becomes the
  terminal state `unconfirmed`, logged by name, with no failed state and no
  nack, because non-delivery cannot be shown. A definitive non-delivery verdict
  fails the obligation and nacks the sender, even after commit: a refusal
  decided before the delivery call (no route, or a named route failure such as
  `gal-without-remote`), or the outbox drain quarantining this reply's own
  record, attributed by the reply id in the quarantined name. A quarantined
  record that cannot be attributed to this reply is not a verdict and resolves
  by the deadline rule.

  **Uncertain and post-commit errors.** A delivery call that throws after
  `delivering` was persisted may have thrown after the bytes left, so it is
  logged `delivery-uncertain:` and resolves by evidence or deadline, never
  `failed`. Every step after a delivery call returns (the `posted` transition,
  the receipt write, the log line) runs under its own guard that logs by name,
  such as `receipt-write-failed`, and records no failure. An error in a later
  step of a committed turn, such as the receipt scan, is logged
  `post-commit-error:<step>` and arms the normal deadline. When the obligation
  store cannot be written as an outcome is recorded, the plugin makes one
  attempt, logs `obligation-write-failed`, and the obligation resolves on a
  later start once the store can be written.

  **One nack path.** Every transition to `failed` goes through the verb, which
  sends the nack mail, so the same verdict gives the same sender-visible
  outcome wherever it is found and no caller mails on its own; how an owed nack
  is retried is in the nack-recovery entry. A terminal record refuses later
  transitions: a final that arrives after the obligation closed, as `acked`,
  `failed` or `unconfirmed`, is logged `late-final-refused` and not delivered,
  and a refused `unconfirmed` or `failed` transition stamps nothing and sends no
  nack. A `nackedAt` stamp on the inbound does not fail an obligation whose
  record says the delivery committed; recovery decides those by evidence and
  deadline.

  `posted` means the reply was handed to its route: sent over the wire to a
  remote branch, delivered into a local maildir, or queued in the outbox for
  the branch drain.

  (Refs #389)
