- **`tps roster dashboard` reads its activity column from the viewer's OrgEvent
  feed, and says when it cannot (Closes #606).** The read sent a `since`
  timestamp Flair rejects and expected a list where Flair returns a paged
  object, so it never returned events. It now sends a valid timestamp and reads
  the viewer's catch-up feed over the last 24 hours (the events addressed to the
  viewer or broadcast, from the viewer's acknowledged position, since that
  floor), page by page up to a bound, and shows each agent's newest event. When
  the read is refused, fails, or returns a malformed response, the command
  prints one line naming the Flair URL and the HTTP status, the error code or
  class, or the malformed part, and the column reads "unavailable" instead of
  "no activity". A read stopped by the bound is reported and marked incomplete.
  In `--json` output each agent carries `activity`: `ok`, `incomplete` or
  `unavailable`.
