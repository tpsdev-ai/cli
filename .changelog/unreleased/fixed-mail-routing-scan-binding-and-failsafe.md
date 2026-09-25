- **A receipt is bound to the reply it answers, and a failure after a delivery committed never fails the send (cli#389 round 6).**

  The receipt scan no longer calls the bridge body a "signed envelope" it does not
  verify. The scan checks a string — the sender the wrapped envelope CLAIMS — and
  the docblocks, the test names, the README and this changelog now say exactly
  that. It also pins one more thing: when the obligation record KNOWS the reply it
  was discharged by (`replyId`, recorded at the posted transition), a receipt must
  carry the same `replyId`, so a body copied from an OLDER reply under the CURRENT
  obligation and inbound ids is not accepted.

  Everything after a delivery call RETURNS now runs OUTSIDE the delivery try,
  each step under its own guard that logs by name and never records a failure:
  the posted transition, the receipt write and the log line are evidence upkeep,
  so a transient error there (a full disk, a throwing logger) can no longer report
  a delivered reply as failed or nack its inbound.

  The retention sweep also fails safe on an unreadable obligation record: such a
  record contributes its id to neither the live nor the terminal set, so its own
  receipt looks orphaned and would be deleted — repairing the record later would
  find its evidence gone. With ANY unreadable record in the store, the sweep
  deletes NO orphan receipt in that pass (terminal-rule deletions, decided from
  records it DID read, still apply) and reports the count.

  (Refs #389)
