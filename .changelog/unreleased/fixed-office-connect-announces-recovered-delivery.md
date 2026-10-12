- **`office connect` announces a relayed delivery recovered after a crash.**
  When an earlier attempt published a delivery's inbox record but stopped
  before announcing it, `office connect` announces the delivery when the
  sender resends it, provided that matching record is still in the mailbox and
  not dead-lettered. A delivery due an announcement is ACKed only after the
  announcement has completed and its announcement marker has been written and
  synced. If the announcement throws or rejects, or the marker cannot be
  written and synced, the delivery is not ACKed, and a resend that still finds
  the record announces it again, unless a marker that failure could not remove
  now syncs (the announcement it records did complete). A marker counts only
  for the payload it records, and only once syncing its file and directory
  succeeds. Announcement is at least once: a resend of the same payload whose
  marker counts is not announced again, but a crash between the announcement
  and its marker, a marker failure, a marker older than the acceptance receipt
  TTL (7 days by default), or two acceptances of the same delivery at once can
  announce it again.
