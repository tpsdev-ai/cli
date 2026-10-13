- **A relayed delivery resent within its retention window writes one inbox record, matched by authenticated branch and delivery id (Closes #513).**

  A relayed inbox record is now named by a key derived from the authenticated
  branch id and the delivery id. A resend of the same id from the same branch is
  matched to that record by its name, so a delivery whose inbox write succeeded
  but whose acceptance receipt was not written (a crash between the two) is not
  written a second time. The same id from a different branch is still delivered.

  A resend is recognised while the record is in the mailbox (new, cur or the
  dead-letter queue) or its acceptance receipt is unexpired (seven days by
  default). Once the record has been acknowledged, archived or garbage-collected
  and the receipt has expired, a resend is delivered again.

  A record under the keyed name that does not parse as a mail record refuses the
  delivery, with no ACK and no replacement. Repair or move it aside so a retry
  can be accepted.
