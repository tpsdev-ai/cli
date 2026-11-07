- **The relay's two in-loop channel-close paths share a helper, and every close and connect-write diagnostic call is compared whole (Refs #807).**

  No behaviour change: a pending close is still awaited and a rejected close
  still retains the channel for `stop()` to retry. The normal-disconnect and
  catch-path closes run the shared helper; `stop()`'s retry and the
  close-after-stop path still call `close()` directly. The failure lines print
  the host state record path and the error text; they do not read host state and
  do not filter what `error.message` contains. The tests compare every
  `console.error` call in those cases, whole and in order, with its complete
  expected line, including the path and the error text.
