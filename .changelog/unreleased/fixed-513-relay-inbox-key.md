- **A relayed resend within its retention window creates no additional inbox record, keyed by authenticated branch and delivery id (Closes #513).**

  A relayed inbox record is now named by a key derived from the authenticated
  branch id and the delivery id. A resend of the same id from the same branch is
  matched to that record by its name, including when the inbox write succeeded
  but the acceptance receipt was not written (a crash between the two). A
  recognised resend creates no additional record: the record keeps its file name
  and id, and its `receivedAt` is refreshed. The same id from a different branch
  is still delivered.

  The retention window lasts while the record is in the mailbox (new, cur or the
  dead-letter queue) or its acceptance receipt is unexpired (seven days by
  default). After a local ACK has removed the record, a matching receipt means a
  resend writes no record at all. Once both the record and the receipt are gone,
  a resend is eligible for a new delivery attempt, and the ordinary inbox and
  dead-letter paths apply to it.

  A record under the keyed name that does not parse as a mail record refuses the
  delivery, with no ACK and no replacement. Repair or move it aside so a retry
  can be accepted.
