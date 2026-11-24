- **A failed startup pre-scan cur/ lookup retries in process instead of waiting for a restart (#1059).**
  An open obligation whose `cur/` lookup errors during the startup pre-scan keeps
  the sweep off its inbound, and now also enters the same bounded retry entry,
  budget and cap the deadline path uses. A repaired path is retried in the same
  process instead of waiting for a restart; at the cap a live record is left open
  and unchanged, one `obligation-retry-exhausted` warning names the error, and no
  nack is sent.
