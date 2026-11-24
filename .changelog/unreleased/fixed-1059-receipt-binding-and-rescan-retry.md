- **Obligation receipt binding also pins the posted mail file, and a failed post-scan missing-cur lookup reports through the bounded retry (#1059).**
  A posted reply record is accepted as a receipt only when its own `id` is the
  reply the obligation names (when a reply id is known); a reply left in the
  recipient's `new/` cannot settle a later reply's obligation. A missing-cur
  recovery whose `cur/` lookup fails after its first receipt scan or after its
  rescan reports the failure through the bounded retry state, and the failed
  attempt settles nothing. A deadline check that lost its owning retry entry
  while the inbound verified writes nothing, and a missing-`cur/` settlement
  re-checks `cur/` at the decision point so a restored inbound is verified and
  stamped instead of acked on the record-only allowance.
