- **`tps mail send` reports a missing remote ACK as delivery unconfirmed, not failure.**
  A remote send waits 30 s for the branch's delivery ACK by default; set the wait
  with `--ack-timeout <ms>` or `TPS_MAIL_ACK_TIMEOUT_MS`. If no ACK arrives in
  that window the command prints the message id, says the message may still
  arrive, and exits 75 (EX_TEMPFAIL). A refused delivery keeps its current error
  and exit status. Re-send with the same `--message-id` to keep the id stable.
