- **`tps office status` reads task, heartbeat and blocker events from the
  viewer's OrgEvent feed, and says when it cannot (Closes #620).** It shares the
  dashboard's read: a valid `since` over the last 6 hours, the viewer's
  catch-up feed (the events addressed to the viewer or broadcast, from the
  viewer's acknowledged position, since that floor), page by page up to a
  bound. From the events read it shows each agent's newest task event, and one
  blocker line for the newest blocker (it showed the first blocker before). For
  the heartbeat, the Agent record's `lastHeartbeat` takes precedence; the newest
  heartbeat event read is the fallback when the record has none. A refused, failed or malformed read prints one line
  naming the Flair URL and the bounded reason, and the task column reads
  "unavailable" instead of "idle"; the rest of the status output still renders.
  A read stopped by the bound is reported and marked incomplete. In `--json`
  output each agent carries `activity`: `ok`, `incomplete` or `unavailable`.
