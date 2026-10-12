- **`tps office status` reads task and heartbeat activity from the viewer's
  OrgEvent feed, and says when it cannot (Closes #620).** It shares the
  dashboard's read: a valid `since` over the last 6 hours, the viewer's
  catch-up feed (the events addressed to the viewer or broadcast, from the
  viewer's acknowledged position, since that floor), page by page up to a
  bound. A refused, failed or malformed read prints one line naming the Flair
  URL and the bounded reason, and the task column reads "unavailable" instead of
  "idle"; the rest of the status output still renders. A read stopped by the
  bound is reported and marked incomplete. In `--json` output each agent
  carries `activity`: `ok`, `incomplete` or `unavailable`.
