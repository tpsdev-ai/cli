- **Reply receipts are per-agent, and a receipt that fails after a delivery committed never fails the send.**

  Two fixes to the reply-receipt loop (cli#389 round 5). Receipts lived in ONE
  host-wide directory while obligations live in per-agent stores, so no
  shared-directory rule could be safe: a rule keyed on the inbound let one
  agent's sweep delete another agent's receipt for the same inbound, and a
  per-agent live guard could hold another agent's aged receipt forever. A
  receipt is now written into the REPLYING agent's own obligation store
  (`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json`) and read from
  there, so the agent's sweep owns exactly its own receipts and keys each one on
  the obligation id — a unique id: a live obligation keeps its receipt, a
  terminal obligation's receipt goes, and a receipt whose obligation is gone goes
  once it has aged past the window (an orphan). The host-wide directory is
  ignored, not migrated.

  Second, a failure AFTER a delivery has committed no longer fails the
  obligation: the bridge's sandbox record carries the obligation ids when the
  caller supplies them, so a bridge delivery stays locally readable evidence even
  when the receipt cannot be written, and on every route a post-commit error is
  logged by name (`receipt-write-failed`) without failing the obligation or
  nacking the inbound. A post-commit error therefore never reports a delivered
  reply as failed; the only thing that still fails a committed delivery is a
  definitive non-delivery verdict (the drain quarantining that reply's own
  record). The wire route's residual is stated in the README: a replying host that cannot
  write its own receipt resolves that obligation at its deadline — or on a later
  start once the store can be written — instead of immediately.

  (Refs #389)
