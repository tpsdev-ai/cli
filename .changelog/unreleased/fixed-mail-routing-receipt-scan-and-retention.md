- **A reply obligation is acked only on a receipt whose signed reply verifies, and receipts live in the replying agent's own store (cli#389, cli#429).**

  **Receipts.** Local, bridge and remote-branch reply receipts include the
  signed reply envelope and are created with mode 0600 in the replying agent's
  obligation store, at
  `<mailDir>/<agent>/.obligations/receipts/<obligation-id>.json`. A receipt
  also names the reply, the obligation, the inbound it answers, the route, the
  branch (for the wire and bridge routes) and the time it was written. The
  outbox route writes none: its record stays in this host's outbox, where the
  scan reads it. A bridge delivery's sandbox record carries the obligation ids
  too, so it is evidence in its own right.

  **What counts as a receipt.** The scan accepts three forms: the metadata
  receipt, the posted reply record carrying the obligation marker, and the
  bridge sandbox record. Each must name this obligation and the inbound it
  answers, and the reply it carries must be a signed envelope from the
  obligated agent, addressed to the inbound's sender, whose signatures verify
  against the key Flair holds for that agent and whose signed `replyToId` is the
  inbound's verified envelope id. For legacy obligations without an inbound
  envelope ID, the scan checks wrapper threading against the inbound record ID
  while still verifying the signed reply's sender and recipient. A record the
  recipient already promoted counts only when its plaintext body and recipient
  are the stored signed envelope's. Metadata and bridge receipts also match the
  recorded reply ID when one is known; all accepted receipt forms must pass
  signature, sender, recipient and applicable thread checks. An unsigned, badly
  signed, foreign-signed or misaddressed record never acks an obligation. When
  Flair cannot be reached to verify a candidate, that is logged
  (`receipt-verify-unavailable`) and the obligation is left to a later scan or
  its deadline.

  **How the store is read.** The receipts store is read ONLY by its direct
  `<obligation-id>.json` path and never listed; the route's posted-record
  directories (the maildir `new`/`cur`, the bridge sandbox, the outbox) are the
  only ones walked. An unreadable file in the receipts store is never read as a
  failed delivery.

  **Retention.** The agent's obligation retention sweep owns its receipts and
  keys each one on the obligation id: a live obligation keeps its receipt, a
  terminal obligation's receipt goes, and a receipt whose obligation is gone (an
  orphan) goes once it has aged past the retention window. An orphan with no
  readable timestamp, and a receipt that names no obligation id, stay in place.
  While any obligation record in the store is unreadable or malformed, the
  sweep deletes no orphan receipt in that pass (terminal-rule deletions,
  decided from records it did read, still apply) and reports the count.

  (Refs #389, #429)
