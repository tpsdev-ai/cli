- **`tps mail watch` now skips and names a `new/` entry whose stat fails in the
  scan's listing with an error other than ENOENT.** Such an entry (a symlink
  loop, a symlink through a regular file) no longer hides the other records:
  the watcher logs its name and error code, then keeps scanning and presenting
  the rest. An entry that vanished keeps today's behaviour.
