- **`tps roster dashboard` reports a refused OrgEvent read.** When Flair answers
  the recent-events read with a non-OK status, or the request fails, the command
  prints the reason and leaves the agent table in place, instead of showing no
  activity as though the read had returned an empty list.
