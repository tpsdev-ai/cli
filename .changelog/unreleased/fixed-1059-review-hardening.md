- **Review hardening for the obligation store and deadline timers (#1059).**
  An arm whose write throws after it verified the record keeps that state as
  the retry baseline. A deadline beyond the runtime's timer limit arms with a
  capped delay and still waits for the original deadline. A receipt scan uses
  the reply id the scanned record names before the dispatch-local id. A record
  whose `inboundId` does not match its file name is unverified to every point
  reader, and a transition patch cannot change the record's write key. A yield
  event that finds the record gone or terminal releases its retry state, and a
  missing-cur recovery re-checks `cur/` after its rescan before settling. A
  startup intake that cannot create the obligation logs the refusal instead of
  rejecting unhandled.
