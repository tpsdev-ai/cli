- **First delivery never replaces or writes through an existing `cur/` record (Closes #482).**

  A consumed ID is a replay; the existing record is kept.
