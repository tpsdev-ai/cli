- **`tps office status` reports a refused or failed OrgEvent read (Closes #620).**
  When Flair answers the recent-events read with a non-OK status, or the request
  fails, the command prints the reason and leaves the rest of the status output
  in place, instead of showing no activity as though the read had returned an
  empty list.
