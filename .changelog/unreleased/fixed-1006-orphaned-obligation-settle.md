- **Recovery re-arms or settles an open reply obligation whose cur/ record is gone.**
  Recovery acts when the `cur/` entry is cleanly absent: a verified receipt
  acknowledges the obligation, otherwise a future deadline is preserved or its
  terminal outcome applied when due. At startup, past the scan limit and with no
  match, the record is left untouched (`SCAN_LIMIT`); a deadline past the limit
  settles only after re-verifying a known `cur/` path that still names the
  inbound, and otherwise reports `SCAN_LIMIT`. Failed outcomes owe a nack
  through the existing at-least-once delivery path. The archiver retains cur/
  while its obligation is non-terminal.
