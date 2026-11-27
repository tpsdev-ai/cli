- **`tps mail watch` now skips and names a `new/` entry it cannot stat.** One
  such entry (a symlink loop, a symlink through a regular file) no longer hides
  the other records: the watcher logs its name and error code, then keeps
  scanning and presenting the rest.
