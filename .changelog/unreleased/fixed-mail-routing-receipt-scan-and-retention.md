- **The shared receipts store is read by direct path only, and the sweep cannot take another obligation's receipt.**

  Two hardening fixes to the reply-receipt scan (cli#389 round 4). The scan took
  one flat list of directories, so the shared `~/.tps/receipts` store — which
  accumulates a file per non-local delivery and is emptied only by the retention
  sweep — was LISTED on every scan, and every retained receipt in it parsed. The
  scan's inputs are split: the receipts store is read only by its direct
  `<obligation-id>.json` path and never listed, while the route's posted-record
  directories (the maildir `new`/`cur`, the bridge sandbox, the outbox) remain
  the only ones walked. An unreadable file in the receipts store can no longer be
  read as a failed delivery.

  The retention sweep treats that directory as SHARED, so it now attributes a
  receipt to a terminal obligation by the PAIR — the obligation id AND the inbound
  it answers — rather than the inbound alone: a terminal obligation and a
  different, still-live obligation that answer the same inbound no longer let the
  first delete the second's fresh receipt. The age rule likewise leaves alone any
  receipt whose obligation is still live, so an outstanding obligation keeps the
  evidence its ack depends on; a receipt whose obligation is gone still ages out.

  (Refs #389)
