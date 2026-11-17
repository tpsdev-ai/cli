- **A live lock or record owner is kept when another process reads its start token under another timezone or locale.** Where
  `/proc` is unavailable (macOS), the process start token comes from `ps -o lstart=`, whose text followed the reading process's
  timezone and locale, so a contender in a different environment could read a live owner's token as a reused pid and take its
  mail lock. `ps` now runs with `TZ=UTC` and `LC_ALL=C`, so every reader of one process gets one token.

  One rule now decides every owner check that compares start tokens (the mail lock, relay, bridge and branch pid files, the
  outbox per-delivery lock and the launch snapshot sweep): a live pid whose recorded `ps:` token differs from its current one
  is unverifiable rather than a reused pid, because a token written before this change, or by a process still running an
  earlier version, can hold local-time text. Such an owner is kept and its process is not signalled. A differing `/proc` token
  still proves pid reuse.

  After upgrading on macOS with a timezone other than UTC, `tps mail relay stop`, `tps bridge stop` and their status commands
  report a relay or bridge started by an earlier version as unverified. Stop that process by its pid and start it again once.
