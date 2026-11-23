- **Obligation receipt binding also pins the posted mail file, and a failed missing-cur rescan lookup schedules a retry (#1059).**
  A posted reply record is accepted as a receipt only when its own `id` is the
  reply the obligation names (when a reply id is known); a reply left in the
  recipient's `new/` cannot settle a later reply's obligation. A missing-cur
  rescan whose `cur/` lookup fails reports the failure through the bounded
  retry state instead of leaving the record with no next check, and the failed
  attempt settles nothing.
