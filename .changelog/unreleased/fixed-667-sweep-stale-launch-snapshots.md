- **`tps agent start` removes `config-*` launch snapshots whose recorded launcher is dead (Closes #667).**

  A forced termination leaves the private config snapshot under `~/.tps/launch`
  behind. A snapshot is now created under a `.pending-config-*` name and renamed
  to `config-*` after its owner record is written, so a published snapshot has
  its owner record; the sweep does not examine pending entries. The owner record
  holds the launching pid and, when one is readable, its process start token. It
  is opened without following a symlink at `owner.json` itself, must be a
  regular file of at most 4 KiB, and is parsed strictly.

  The next launch removes a published entry whose pid is gone, or whose pid is
  alive under a different readable start token from the same source; a live pid
  is kept when either token is unavailable or the two come from different
  sources, and so is a published entry whose owner record names a live pid under
  the same readable token. An entry with no readable owner record is kept until
  its directory mtime is past a one-minute grace; an entry whose mtime cannot be
  read is kept, and the sweep does not examine pending entries.
