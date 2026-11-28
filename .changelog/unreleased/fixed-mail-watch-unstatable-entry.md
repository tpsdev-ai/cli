- **`tps mail watch` skips and names a `new/` entry whose stat fails in a
  successful listing with an error other than ENOENT.** Each successful listing
  of `new/` — the scan's and the trim's — names its unstatable entries: the
  watcher logs each name and error code, then keeps scanning and presenting the
  rest. An entry that vanished is still dropped silently.
