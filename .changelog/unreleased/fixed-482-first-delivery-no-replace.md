- **First delivery’s exclusive link does not replace an existing `cur/` destination (Closes #482).**

  Record collisions compare the signed envelope in `record.body` when its shape
  is valid, otherwise `record.envelope`, and attempt dead-lettering: `replay` for
  equal from/to/subject/body/replyToId, `invalid` for different content.
  Non-record destinations:
  CLI returns `storage-unavailable`; MailClient withholds delivery and keeps the
  source in `new/`.
