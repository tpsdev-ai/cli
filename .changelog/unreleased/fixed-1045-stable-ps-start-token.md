- **A live mail-lock, pid-file or launch-snapshot owner is kept when another process reads its start token under another timezone or locale.** Where
  `/proc` is unavailable (macOS), the process start token comes from `ps -o lstart=`, whose text followed the reading process's
  timezone and locale, so a contender in a different environment could read a live owner's token as a reused pid and take its
  mail lock. `ps` now runs with `TZ=UTC` and `LC_ALL=C`, so every reader of one process gets one token.

  One rule now decides the owner checks that compare start tokens in the mail lock, the relay, bridge and branch pid files, the
  outbox per-delivery lock and the launch snapshot sweep: a live pid whose recorded `ps:` token differs from its current one
  is unverifiable rather than a reused pid, because a token written before this change, or by a process still running an
  earlier version, can hold local-time text. Such an owner is kept and its process is not signalled. A differing `/proc` token
  still proves pid reuse. The host-state ownership check and the released-agent identity check still compare tokens directly
  and are not changed here.

  After upgrading on macOS with a timezone other than UTC, `tps mail relay stop`, `tps bridge stop` and their status commands
  may report a relay or bridge started by an earlier version as unverified, when the token it recorded differs from the
  current one. Check that the pid still belongs to that relay or bridge (for example `ps -p <pid> -o command=`), then stop it
  by its pid and start it again once.
