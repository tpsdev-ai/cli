- **`tps mail check` says why a message is re-delivered.**

  A `cur/` record that is re-verified and re-presented after its 30-minute
  checkout lease expired is marked as re-delivered. For ackable mail it prints
  `tps mail ack <id> --agent <agent>`; for external-tier mail it says
  that `tps mail ack` and `tps mail nack` refuse it. `--json` carries the `redelivered` field.
