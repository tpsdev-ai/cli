- **`tps mail check` says why a message is re-delivered.**

  An unacked `cur/` record whose checkout is older than the 30-minute lease is
  marked as re-delivered. For ackable mail it prints
  `tps mail ack <id> --agent <agent>`; external-tier mail is reported as not
  ackable by an internal consumer. `--json` carries the `redelivered` field.
