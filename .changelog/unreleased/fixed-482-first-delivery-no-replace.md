- **First delivery into `cur/` never replaces an existing record; a colliding filename is a duplicate or an integrity error (Closes #482).**

  Previously `promote()` and `MailClient` moved a record into `cur/` with a
  rename, so a colliding filename could overwrite an already-delivered record.
  First delivery now uses an exclusive link and never replaces it: an identical
  record is an idempotent duplicate (dead-lettered as a replay) and a different
  record under the same filename is dead-lettered as an integrity error naming
  the record id. The delivered record is left untouched.
