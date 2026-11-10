- **`tps mail relay status`, `tps mail relay stop` and `tps bridge status` (human output) describe bad or unverifiable pid files instead of reporting "not running".**

  An invalid, stale, unverified or unreadable pid file is no longer reported
  as the relay or bridge not running. `tps mail relay status` names the record
  and reports the relay's state as unknown or unverified. `tps bridge status` (human output,
  when no bridge record is running) prints
  `Bridge state unknown (<kind> pid file <path>).` for each such record.
  `tps mail relay stop` names an
  invalid or stale record, signals no process for it, removes it when the
  unlink succeeds, and leaves the relay's state unknown. When a signalled
  relay's recorded pid is proved gone, stop now prints a line beginning
  `Recorded relay process (pid N) is gone (`.
