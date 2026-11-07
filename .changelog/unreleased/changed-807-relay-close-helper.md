- **The relay's channel-close paths share one helper, and the diagnostics are pinned not to print record contents (Refs #807).**

  No behaviour change: a pending close is still awaited, a rejected close still
  retains the channel for `stop()` to retry, and the failure line still names
  the record path and the reason, not the record.
