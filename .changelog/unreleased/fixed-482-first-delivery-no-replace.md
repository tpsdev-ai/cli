- **First delivery into `cur/` never replaces an existing record (Closes #482).**

  Collisions with delivered records trigger attempted dead-lettering: replay for
  the same delivery content (from/to/subject/body/replyToId), integrity error for
  different delivery content. A non-record destination is a storage failure.
