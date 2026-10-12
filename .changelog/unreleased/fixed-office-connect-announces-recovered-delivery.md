- **`office connect` attempts announcements for recovered relayed deliveries.**
  On a resend, a matching record still in the mailbox outside the dead-letter
  queue is due an announcement if acceptance receipt recovery and sync succeed.
  The callback is attempted unless a matching, unexpired announcement marker's
  file and directory sync successfully. The ACK follows a successful marker check or
  a completed callback and successful marker write and sync. Callback errors,
  or a marker that cannot be written and synced, withhold that attempt's ACK.
  A resend that still finds the record and recovers its receipt attempts the
  callback again unless an announcement marker counts. Cleanup attempts removal
  of the temp file or renamed marker; the retained-marker sync check is the
  fallback. A marker counts only
  for the payload it records, and only once syncing its file and directory
  succeeds. A resend of the same payload whose
  marker counts is not announced again, but a crash between the announcement
  and its marker, a marker failure, a marker older than the acceptance receipt
  TTL (7 days by default), or two acceptances of the same delivery at once can
  announce it again.
