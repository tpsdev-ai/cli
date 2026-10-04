- **First delivery never replaces or writes through an existing `cur/` record (Closes #482).**

  A delivery that passes the signature and mailbox checks and carries an already-consumed ID is treated as a replay and the existing `cur/` record is kept; other outcomes are main's, unchanged.
