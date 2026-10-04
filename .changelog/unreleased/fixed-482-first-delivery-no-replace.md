- **First delivery’s exclusive link does not replace an existing `cur/` destination (Closes #482).**

  Collisions with delivered records trigger attempted dead-lettering: replay for
  the same delivery content (from/to/subject/body/replyToId), integrity error for
  different delivery content. A non-record destination is a storage failure.

  A crash after linking but before the consumed-ID append leaves an uncommitted
  `cur/` record: presentation withholds it, and retrying its ID is refused as replay.
