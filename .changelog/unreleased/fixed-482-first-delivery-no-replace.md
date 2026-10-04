- **First delivery into `cur/` never replaces an existing record (Closes #482).**

  First delivery uses an exclusive link. Under the same filename, same delivery
  content (from/to/subject/body/replyToId) is dead-lettered as a duplicate
  (replay); different delivery content is dead-lettered as an integrity error.
  A non-record destination is a storage failure.
