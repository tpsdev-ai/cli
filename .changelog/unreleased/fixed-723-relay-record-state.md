- **`tps mail relay status`, `tps mail relay stop` and `tps bridge status` describe a bad or unverifiable pid file instead of reporting "not running".**

  An invalid, stale, unverified or unreadable pid file is described by its
  record instead of being reported as the relay or bridge not running:
  `tps mail relay status` and `tps bridge status` name the record and its
  state, and `tps mail relay stop` names the record, signals no process for
  it, removes an invalid or stale file when the unlink succeeds, and prints
  `Recorded relay process (pid N) is gone` when the recorded pid is proved
  gone.
