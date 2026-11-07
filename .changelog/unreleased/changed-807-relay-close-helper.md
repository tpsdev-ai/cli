- **The relay's two in-loop channel-close paths share a helper, and the close and connect-write failure lines are pinned to their complete text (Refs #807).**

  No behaviour change: a pending close is still awaited and a rejected close
  still retains the channel for `stop()` to retry. The normal-disconnect and
  catch-path closes run the shared helper; `stop()`'s retry and the
  close-after-stop path still call `close()` directly. The failure lines print
  the host state record path and the error text; they do not read host state and
  do not filter what `error.message` contains. The tests pin the complete text
  of the close and connect-write failure lines, including the path and the error
  text.
