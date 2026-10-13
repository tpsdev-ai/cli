- **`tps dashboard` and `tps office status` read per-agent activity from Flair's Presence roster and label the column for what it shows.**

  Both views read the office-wide `GET /Presence` roster — the per-agent state
  each agent pushes — instead of the viewer's OrgEvent catch-up feed. The
  dashboard's last column is `Last Seen`, the presence status and the age of the
  agent's last heartbeat; office status shows the same in `LAST SEEN` and the
  agent's current task or activity in `ACTIVITY`. An agent with no presence
  record reads `never seen`; a read that fails reads `unavailable`, not an empty
  column. Office status prints no blocker line.
