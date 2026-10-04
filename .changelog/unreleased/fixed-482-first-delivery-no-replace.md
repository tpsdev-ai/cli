- **First delivery’s exclusive link does not replace an existing `cur/` destination (Closes #482).**

  Record collisions attempt dead-lettering: `replay` for equal
  from/to/subject/body/replyToId, `invalid` otherwise. Non-record destinations:
  CLI returns `storage-unavailable`; MailClient withholds delivery and keeps the
  source in `new/`.

  A crash after linking but before the consumed-ID append leaves an uncommitted
  `cur/` record: presentation withholds it, and retrying it is refused as replay.
