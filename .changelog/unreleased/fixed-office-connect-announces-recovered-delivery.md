- **`office connect` announces a relayed delivery recovered after a crash.** A
  delivery whose inbox record was published by an attempt that stopped before
  announcing it is announced when the sender resends it. A delivery due an
  announcement is ACKed only after the announcement has completed and been
  recorded: if the announcement throws or rejects, or its record cannot be
  written, the delivery is not ACKed, and a resend that finds its inbox record
  announces it. Announcement is at least once. A resend of the same payload
  whose announcement is recorded is not announced again, but a crash between
  the announcement and its record, a record that cannot be written, a record
  older than the acceptance receipt TTL (7 days by default), or two
  acceptances of the same delivery at once can announce it again.
