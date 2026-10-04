- **First delivery never replaces or writes through an existing `cur/` record (Closes #482).**

  A delivery never replaces or writes through an existing `cur/` record: it is created exclusively on a fresh unique scratch path, and a stranded scratch link is removed without writing through it.
