- **`tps mail send` reports a missing remote ACK as delivery unconfirmed, not failure.**
  A remote send waits 30 s for the branch's delivery ACK by default; set the wait
  with `--ack-timeout <ms>` or `TPS_MAIL_ACK_TIMEOUT_MS`. If no ACK arrives in
  that window the command prints the message id and exits 75 (EX_TEMPFAIL). A
  refused delivery keeps its current error and exit status. A re-send with the
  same `--message-id` reuses the signed envelope stored for that id (same id,
  timestamp and payload) only when it still verifies with the sender's current
  key and both the inbound delegation chain and `--reply-to` match; an existing
  stored entry that fails those checks is refused by name and nothing is sent.
  A stored entry that is missing is signed again under that id and sent, and one
  older than 7 days is signed again when it can be cleared, otherwise the
  re-send is refused. While the first copy is still in the branch's inbox, a
  re-send with the same id adds no second copy, and if the branch's inbox still
  holds a different payload under that id, it refuses this one as a same-id
  conflict. A remote send that generated its id stores that signed envelope
  too. A connection the branch closes before the ACK reports delivery
  unconfirmed as well. [#980](https://github.com/tpsdev-ai/cli/pull/980).
