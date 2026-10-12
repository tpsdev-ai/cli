- **Relay acceptance receipts store a digest and byte length of the accepted payload, not the payload itself (Closes #579).**

  A schema-valid receipt already on disk that holds the payload is compared
  by its digest while it remains within its TTL.
