- **Obligation receipt binding also pins the posted mail file, and a failed missing-cur rescan lookup schedules a retry (#1059).**
  A posted reply record is accepted as a receipt only when its own `id` is the
  reply the obligation names (when a reply id is known); a reply left in the
  recipient's `new/` cannot settle a later reply's obligation. A missing-cur
  rescan whose `cur/` lookup fails reports the failure through the bounded
  retry state instead of leaving the record with no next check, and the failed
  attempt settles nothing. A deadline check that lost its owning retry entry
  while the inbound verified writes nothing, and a missing-`cur/` settlement
  re-checks `cur/` at the decision point so a restored inbound is verified and
  stamped instead of acked on the record-only allowance.
