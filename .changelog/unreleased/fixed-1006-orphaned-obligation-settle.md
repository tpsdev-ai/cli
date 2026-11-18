- **Recovery attempts to re-arm or settle an open reply obligation whose cur/ record is gone.**
  Missing-entry recovery acts only when the `cur/` entry is cleanly absent; it
  attempts to settle the obligation with a verified receipt, which acknowledges
  it, and otherwise attempts to preserve a future deadline or apply its terminal
  outcome when due. These attempts take effect when their write succeeds. At
  startup, past the scan limit and with no match, the record is left untouched
  (`SCAN_LIMIT`). Past the limit, when a known `cur/` path still names the
  inbound, the deadline attempts to settle after re-verifying that path, and
  takes effect only when re-verification and the write succeed; when no known
  path names the inbound, the record is left untouched with `SCAN_LIMIT` (logged
  once per inbound per process). Failed outcomes owe a nack through the existing
  at-least-once delivery path. The archiver retains cur/ while its obligation is
  non-terminal.
