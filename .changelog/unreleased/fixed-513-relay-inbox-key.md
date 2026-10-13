- **Relay delivery is idempotent by branch and delivery id, so a resend after a lost ACK writes one inbox record (Closes #513).**

  A relayed inbox record is now named by a key derived from the authenticated
  branch id and the delivery id. An acceptance resend recognises the record by
  that key without reading any other record, so a delivery whose inbox write
  succeeded but whose acceptance marker was not written (a crash between the two)
  is not written a second time. The key is computed from the branch the relay
  channel authenticated and the id the branch sent, not from any field of the
  record; the same id from a different branch is still delivered.
