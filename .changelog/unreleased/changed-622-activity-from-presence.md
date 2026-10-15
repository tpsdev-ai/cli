- **`tps roster dashboard` and `tps office status` read per-agent presence from the Presence roster of the Flair instance they query.**

  Both views read `GET /Presence` from the queried Flair instance instead of the
  viewer's OrgEvent catch-up feed. Agents push heartbeats, their activity and
  their current task to Flair; Flair derives each agent's status and whether its
  activity is still fresh when it serves the read. The dashboard's last column
  is `Last Seen`: the presence status and the age of the agent's last heartbeat.
  Office status shows the same in `LAST SEEN`, and also the agent's current task
  or activity in `ACTIVITY`, or `was: <last activity>` (Flair's `lastActivity`)
  once Flair reports the activity stale. Presence is per Flair instance (Flair
  federation does not replicate it), so an agent with no record on the queried
  instance reads `no presence on this instance`. The presence columns read
  `unavailable`, not an empty column, when the read cannot be signed (it is then
  not sent) or fails, or when the roster has a missing or invalid field the
  views read, fields that contradict how Flair derives them, or
  two records for one agent. Office status prints no blocker line.
