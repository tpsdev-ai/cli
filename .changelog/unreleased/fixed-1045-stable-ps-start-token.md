- **A live mail-lock holder keeps its lock when a contender reads its start token under another timezone or locale.** Where `/proc`
  is unavailable (macOS), the process start token comes from `ps -o lstart=`, whose text followed the reading process's timezone
  and locale, so a contender in a different environment could read a live holder's token as a reused pid and take the lock.
  `ps` now runs with `TZ=UTC` and `LC_ALL=C`, so every reader of one process gets one token.

  A live pid whose recorded `ps:` token differs from its current one is now unverifiable rather than a reused pid, because a
  token written before this change can hold local-time text. Such a mail lock, or a relay, bridge or branch pid file, is kept
  and its process is not signalled. A differing `/proc` token still proves pid reuse.

  After upgrading on macOS with a timezone other than UTC, `tps mail relay stop`, `tps bridge stop` and their status commands
  report a relay or bridge started by an earlier version as unverified. Stop that process by its pid and start it again once.
