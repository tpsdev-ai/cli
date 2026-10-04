- **First delivery never replaces or writes through an existing `cur/` record (Closes #482).**

  A delivery never replaces an existing `cur/` record: both writers place it with an exclusive hard link.
