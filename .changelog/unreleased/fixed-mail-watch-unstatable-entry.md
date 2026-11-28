- **`tps mail watch` skips and names a `new/` entry whose stat fails in a
  successful listing with an error other than ENOENT.** Every successful listing
  of `new/` — the scan's and the trim's — updates the shared warning state: an
  entry's name and error code are logged once per continuous observed failure,
  and logged again only after it is absent from, or stats successfully on, a
  successful listing and then fails again. The watcher keeps scanning and
  presenting the rest. An entry that
  vanished is still dropped silently.
