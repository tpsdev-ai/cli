- **Rejected-close tests compare unfiltered `console.error` calls before and after `stop()` with the expected one-argument arrays in order (Refs #807).**

  No behaviour change: a pending close is still awaited and a rejected close
  still retains the channel for `stop()` to retry. The normal-disconnect and
  catch-path closes run the shared helper; `stop()`'s retry and the
  close-after-stop path still call `close()` directly. The failure lines print
  the host state record path and the error text; they do not read host state and
  do not filter what `error.message` contains. The rejected-close tests compare the unfiltered
  `console.error` call lists before and after `stop()` with the expected
  one-argument arrays in order; the connect-write tests compare unfiltered
  calls with the expected one-argument arrays in order.
