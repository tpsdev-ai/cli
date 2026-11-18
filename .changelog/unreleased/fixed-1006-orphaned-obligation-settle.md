- **Recovery attempts to re-arm or settle an open reply obligation whose cur/ record is gone.**
  When the `cur/` entry is cleanly absent, recovery attempts to settle the
  obligation with a verified receipt, which acknowledges it; otherwise it
  attempts to preserve a future deadline or apply its terminal outcome when due.
  These attempts take effect when their write succeeds. At startup, past the scan
  limit and with no match, the record is left untouched (`SCAN_LIMIT`); a
  deadline past the limit settles only after re-verifying a known `cur/` path
  that still names the inbound, and otherwise reports `SCAN_LIMIT`. Failed
  outcomes owe a nack through the existing at-least-once delivery path. The
  archiver retains cur/ while its obligation is non-terminal.
