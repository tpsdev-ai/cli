- **The commit is a PERSISTED state of the obligation record, so nothing after a delivery commits fails a delivered reply (cli#389 round 8).**

  Round 7 guarded a `committed` flag held in the turn's memory, and the record was
  still the only durable truth: in the same process the deadline path mailed a nack
  for a reply that had already been delivered, and after a restart the same
  obligation failed and nacked. The commit is now a persisted state of the
  obligation record — `delivering` written BEFORE the delivery call, `posted` the
  moment it returns — so the turn, the deadline timer and a restart all read the
  same truth, and ONE verb settles the obligation from that record. Every writer of
  `failed` or `nackedAt` goes through it, including the restart-recovery path that
  used to write `failed` directly.

  It decides from the record: evidence found gives `acked`; `delivering` or
  `posted` at the deadline with no evidence gives the new terminal state
  `unconfirmed` — no failed state, no nack stamp and no nack mail, logged by name,
  because non-delivery cannot be proven and the sender is never told a delivered
  reply failed; and a DEFINITIVE non-delivery verdict fails and nacks even after
  commit. A definitive verdict is an explicit delivery rejection, a delivery call
  that failed, or the outbox drain quarantining THIS reply's own record —
  attributed by the reply id in the quarantined name. An unrelated `.malformed-*`
  marker, or an evidence step that threw, is not a verdict: a throw from a
  post-commit step is logged by name (`post-commit-error:<step>`) and arms the
  normal deadline instead of stranding the obligation, and an unattributable marker
  resolves by the deadline rule. This restores cli#398 T4(e) as a real test of
  attributable quarantine: a reply whose own record the drain quarantined fails
  with `receipt-malformed`.

  (Refs #389)
