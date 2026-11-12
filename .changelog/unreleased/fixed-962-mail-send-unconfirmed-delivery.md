- **`tps mail send` reports a missing remote ACK as delivery unconfirmed, not failure.**
  A remote send waits 30 s for the branch's delivery ACK by default; set the wait
  with `--ack-timeout <ms>` or `TPS_MAIL_ACK_TIMEOUT_MS`. If no ACK arrives in
  that window the command prints the message id and exits 75 (EX_TEMPFAIL). A
  refused delivery keeps its current error and exit status. A re-send with the
  same `--message-id` reuses the signed envelope stored for that id (same id,
  timestamp and payload) only when it still verifies with the sender's current
  key and both the inbound delegation chain and `--reply-to` match, and the
  branch inbox then accepts it as a duplicate; an existing stored entry that
  fails those checks is refused by name and nothing is sent. A stored entry
  that is missing or older than 7 days is signed again under that id and sent,
  with the current millisecond as its timestamp, so the branch inbox accepts it
  as a duplicate only if the payload matches one it already accepted, and
  otherwise refuses it as a same-id conflict. A remote send
  that generated its id stores that signed envelope too, so the retry the
  unconfirmed message prints re-sends the same bytes. A connection the branch
  closes before the ACK reports delivery unconfirmed as well. A
  `TPS_INBOUND_CHAIN_JSON` chain is refused before signing when it has 16 or
  more entries (`delegation chain exceeds the maximum of 16 hops`) or when a
  hop's `signature` is not the one its kind carries (a string for an agent hop,
  `null` for a human hop).
