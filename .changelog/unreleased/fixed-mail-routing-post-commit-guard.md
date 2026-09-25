- **The one verb that fails or nacks an obligation refuses once a delivery has committed (cli#389 round 7).**

  Round 6 moved post-commit calls out of the delivery try one at a time and missed
  the same class twice: a throw raised AFTER a delivery call returned — the ACK
  transition writing the obligation, the receipt scan, the failedCounts log —
  landed in the dispatch's outer catch, which failed the obligation and nacked the
  inbound of a reply that was already on the wire. The turn's context now carries a
  `committed` flag, set the moment the delivery call returns, and `failObligation`
  refuses while it is set: no failed state, no nack, one `post-commit-error:<step>`
  log line naming the step, and the obligation resolves from its receipt (or from
  the bridge's sandbox record). Every present and future post-commit path is
  covered at once, whichever catch it lands in. A pre-commit failure — the dispatch
  itself throwing, a missing signing key, an unroutable recipient — still fails and
  nacks exactly as before.

  One pre-existing exception is retired with it: cli#398 T4(e), where a reply posted
  to the outbox whose record could not be read back was a named `receipt-malformed`
  failure. That delivery had committed, so the guard now refuses that failure too;
  with the evidence unreadable the obligation resolves at its DEADLINE, exactly like
  the wire route's missing receipt.

  (Refs #389)
